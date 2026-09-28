/* efferon-training.js - live training sessions on the Efferon portal

   WHAT IT DOES
     Shows the upcoming live training sessions (date, time, module, short
     agenda) on the home page and on the Training category, and lets a signed-in
     reader register for one. Registration prefills name + e-mail from the
     portal profile (editable), asks for the company (remembered by this
     browser), an optional second e-mail for the invite and an optional comment.

   WHERE THE DATA COMES FROM
     An Apps Script (run by zendesk@efferon.com) writes the published sessions
     into one Zendesk article as base64 JSON:
       <div id="efferon-training" data-training="...">
     This module reads that article through the same-origin Help Center API.
     The Zoom link is NOT in the article (every reader of the article would see
     it) - registrants get it in the calendar invite and the confirmation mail.
     Contract: efferon-tools/training/sessions/CONTRACT.md

   WHY A FORM AND NOT fetch()
     Help Center CSP: connect-src 'self' blocks fetch to Google; form-action is
     http: https:, so a native <form method="post" target="_blank"> is the one
     outbound channel (same as the knowledge checks and the consent gate). The
     answer opens in a new tab; this page only says what it knows: the request
     left, the new tab has the verdict, the invite follows by e-mail.

   MOUNT POINTS
     #efr-training-home  - home page (compact: next session + up to 2 more)
     #efr-training-cat   - Training category (all sessions, empty state)
     If the Training category page has no mount point, one is inserted at the
     top of the page content, so no category template edit is needed.

   SETTINGS (window.EFFERON, from document_head.hbs)
     trainingArticle   - id of the article that carries the payload
     trainingCategory  - id of the Training category
     trainingEndpoint  - Register /exec URL (fallback; payload value wins)
     trainingAdminUrl  - Admin /exec URL; staff (@efferon.com) see "Manage sessions"

   SANDBOX HOOKS (never set on the portal)
     EFFERON.trainingData   - payload object, skips the article fetch
     EFFERON.trainingMe     - user object, skips /api/v2/users/me.json
     EFFERON.trainingSubmit - function(fields, session) called instead of the
                              native POST; may return {outcome:"..."}.
*/
(function () {
  "use strict";

  var CFG = window.EFFERON || {};
  var LOCALE = (location.pathname.match(/\/hc\/([^/]+)/) || [])[1] || "en-001";  /* same as efferon-home.js */
  var ORG_TZ = "Europe/Berlin";
  var CONTACT = "zendesk@efferon.com";
  var LS_COMPANY = "efr_training_company";

  /* ------------------------------------------------------------ utils */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function b64json(s) { return JSON.parse(decodeURIComponent(escape(atob(s)))); }
  function readerTz() {
    if (CFG.trainingTz) return CFG.trainingTz;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ORG_TZ; } catch (e) { return ORG_TZ; }
  }
  function fmt(d, tz, opts) {
    var o = { timeZone: tz }; for (var k in opts) o[k] = opts[k];
    try { return new Intl.DateTimeFormat("en-GB", o).format(d); }
    catch (e) { o.timeZone = undefined; return new Intl.DateTimeFormat("en-GB", o).format(d); }
  }
  function tzAbbr(d, tz) {
    try {
      var p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(d);
      for (var i = 0; i < p.length; i++) if (p[i].type === "timeZoneName") return p[i].value;
    } catch (e) {}
    return "";
  }
  function hm(d, tz) { return fmt(d, tz, { hour: "2-digit", minute: "2-digit", hour12: false }); }
  function sameClock(a, tzA, tzB) { return hm(a, tzA) === hm(a, tzB) && fmt(a, tzA, { day: "numeric" }) === fmt(a, tzB, { day: "numeric" }); }
  function cityOf(tz) { var p = tz.split("/"); return p[p.length - 1].replace(/_/g, " "); }

  function when(s) {
    var st = new Date(s.start), en = new Date(s.end), tz = readerTz();
    var orgLabel = tzAbbr(st, ORG_TZ) || "CET";
    var local = hm(st, tz) + "–" + hm(en, tz);
    var org = hm(st, ORG_TZ) + "–" + hm(en, ORG_TZ) + " " + orgLabel;
    var same = sameClock(st, tz, ORG_TZ);
    return {
      day: fmt(st, tz, { day: "numeric" }),
      mon: fmt(st, tz, { month: "short" }),
      wd: fmt(st, tz, { weekday: "long" }),
      dateLong: fmt(st, tz, { weekday: "long", day: "numeric", month: "long" }),
      local: local,
      org: org,
      same: same,
      tzCity: cityOf(tz),
      line: same ? org : local + " your time (" + cityOf(tz) + ") · " + org
    };
  }
  function phase(s, now) {
    var st = +new Date(s.start), en = +new Date(s.end);
    if (now >= en) return "past";
    if (now >= st - 15 * 60000) return "live";
    if (st - now < 48 * 3600000) return "soon";
    return "later";
  }
  function relDays(s, now) {
    var d = Math.round((+new Date(s.start) - now) / 86400000);
    if (d <= 0) return "today"; if (d === 1) return "tomorrow"; return "in " + d + " days";
  }
  function regKey(uid, sid) { return "efr_training_reg_" + (uid || "anon") + "_" + sid; }

  /* ------------------------------------------------------------ data */
  function loadPayload() {
    if (CFG.trainingData) return Promise.resolve(CFG.trainingData);
    if (!CFG.trainingArticle) return Promise.resolve(null);
    return fetch("/api/v2/help_center/" + LOCALE + "/articles/" + CFG.trainingArticle + ".json", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.article) return null;
        var box = document.createElement("div"); box.innerHTML = d.article.body || "";
        var mod = box.querySelector("#efferon-training[data-training]");
        return mod ? b64json(mod.getAttribute("data-training")) : null;
      })
      .catch(function () { return null; });
  }
  function loadMe() {
    if (CFG.trainingMe !== undefined) return Promise.resolve(CFG.trainingMe);
    return fetch("/api/v2/users/me.json", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.user && d.user.id ? d.user : null; })
      .catch(function () { return null; });
  }

  /* ------------------------------------------------------------ styles */
  var CSS = [
    ".eft{--eft-blue:var(--blue,#4568a9);--eft-deep:var(--blue-deep,#2c4a85);--eft-ink:var(--ink,#182236);--eft-ink2:var(--ink-2,#3d4a63);",
    "--eft-ink3:var(--ink-3,#5a6780);--eft-hair:var(--hair,rgba(69,104,169,.14));--eft-teal:var(--teal-deep,#178f83);--eft-rasp:var(--rasp-deep,#c9505f);",
    "--eft-grad:var(--grad-brand,linear-gradient(120deg,#4568a9,#5a65a4 26%,#896896 50%,#c26b7e 74%,#e16f7a));color:var(--eft-ink)}",
    ".eft *{box-sizing:border-box}.eft [hidden]{display:none!important}",
    ".eft-card{position:relative;display:grid;grid-template-columns:118px 1fr auto;gap:28px;align-items:center;padding:28px 30px;border-radius:var(--r,26px);",
    "background:var(--glass,rgba(255,255,255,.62));border:1px solid var(--glass-border,rgba(255,255,255,.66));box-shadow:var(--sh-sm),inset 0 1px 0 rgba(255,255,255,.7);overflow:hidden}",
    "@supports ((backdrop-filter:blur(20px)) or (-webkit-backdrop-filter:blur(20px))){.eft-card,.eft-row{-webkit-backdrop-filter:blur(20px) saturate(1.5);backdrop-filter:blur(20px) saturate(1.5)}}",
    ".eft-card::before{content:'';position:absolute;width:380px;height:380px;border-radius:50%;right:-150px;top:-190px;pointer-events:none;background:radial-gradient(circle,rgba(225,111,122,.12),transparent 68%)}",
    ".eft-date{width:118px;height:118px;border-radius:24px;background:#fff;box-shadow:0 1px 2px rgba(24,34,54,.05),0 14px 30px -18px rgba(44,74,133,.35);display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative}",
    ".eft-date::before{content:'';position:absolute;left:0;right:0;top:0;height:6px;border-radius:24px 24px 0 0;background:var(--eft-grad)}",
    ".eft-date b{font-size:44px;line-height:1;font-weight:700;letter-spacing:-.04em;color:var(--eft-ink)}",
    ".eft-date span{font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--eft-blue);margin-top:6px}",
    ".eft-date i{font-style:normal;font-size:11.5px;color:var(--eft-ink3);margin-top:2px}",
    ".eft-body{min-width:0;position:relative}",
    ".eft-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:8px}",
    ".eft-mod{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--eft-deep);background:rgba(69,104,169,.09);border-radius:999px;padding:4px 11px}",
    ".eft-flag{font-size:12px;font-weight:600;color:var(--eft-teal)}.eft-flag.live{color:var(--eft-rasp)}",
    ".eft-flag.live::before{content:'';display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;margin-right:6px;vertical-align:1px;animation:eft-pulse 1.6s infinite}",
    "@keyframes eft-pulse{50%{opacity:.35}}",
    ".eft-title{font-size:21px;font-weight:700;letter-spacing:-.02em;line-height:1.25;margin:0 0 6px;color:var(--eft-ink)}",
    ".eft-time{font-size:14.5px;color:var(--eft-ink2);margin:0}",
    ".eft-time small{display:block;font-size:12.5px;color:var(--eft-ink3);margin-top:2px}",
    ".eft-agenda{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:5px}",
    ".eft-agenda li{position:relative;padding-left:16px;font-size:14px;color:var(--eft-ink2);line-height:1.45}",
    ".eft-agenda li::before{content:'';position:absolute;left:2px;top:.62em;width:5px;height:5px;border-radius:50%;background:var(--eft-blue);opacity:.55}",
    ".eft-agenda .more{padding-left:16px;color:var(--eft-ink3);font-size:13px}.eft-agenda .more::before{display:none}",
    ".eft-host{font-size:13px;color:var(--eft-ink3);margin-top:10px}",
    ".eft-act{display:flex;flex-direction:column;align-items:stretch;gap:10px;min-width:170px;position:relative}",
    ".eft-btn{appearance:none;border:0;cursor:pointer;border-radius:999px;padding:13px 24px;font:inherit;font-weight:600;font-size:15px;line-height:1.2;text-align:center;",
    "background:var(--eft-grad);color:#fff;box-shadow:0 12px 26px -10px rgba(120,72,120,.55);transition:transform .25s var(--spring,ease),box-shadow .25s}",
    ".eft-btn:hover{transform:translateY(-2px);box-shadow:0 16px 32px -10px rgba(120,72,120,.62);color:#fff}",
    ".eft-btn:focus-visible,.eft-ghost:focus-visible{outline:3px solid rgba(33,185,170,.45);outline-offset:2px}",
    ".eft-btn[disabled]{opacity:.45;cursor:default;transform:none;box-shadow:none}",
    ".eft-ghost{appearance:none;border:0;cursor:pointer;background:transparent;font:inherit;font-size:14px;font-weight:600;color:var(--eft-blue);padding:8px 10px;border-radius:999px}",
    ".eft-ghost:hover{background:rgba(69,104,169,.08)}",
    ".eft-done{display:flex;align-items:center;justify-content:center;gap:8px;border-radius:999px;padding:12px 18px;font-size:14.5px;font-weight:600;color:var(--eft-teal);background:rgba(33,185,170,.1)}",
    ".eft-done svg{width:18px;height:18px}",
    ".eft-seats{font-size:12.5px;color:var(--eft-ink3);text-align:center}.eft-seats.low{color:var(--eft-rasp)}",
    ".eft-list{display:flex;flex-direction:column;gap:12px;margin-top:14px}",
    ".eft-row{display:grid;grid-template-columns:64px 1fr auto;gap:18px;align-items:center;padding:16px 20px;border-radius:var(--r-sm,18px);",
    "background:var(--glass,rgba(255,255,255,.62));border:1px solid var(--glass-border,rgba(255,255,255,.66));box-shadow:var(--sh-sm)}",
    ".eft-row .d{text-align:center;line-height:1.1}.eft-row .d b{display:block;font-size:24px;font-weight:700;letter-spacing:-.03em}",
    ".eft-row .d span{font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--eft-blue)}",
    ".eft-row h4{margin:0;font-size:15.5px;font-weight:650;letter-spacing:-.01em}.eft-row p{margin:2px 0 0;font-size:13px;color:var(--eft-ink3)}",
    ".eft-row .eft-ghost{white-space:nowrap}",
    ".eft-empty{padding:26px 28px;border-radius:var(--r-sm,18px);border:1px dashed rgba(69,104,169,.28);color:var(--eft-ink3);font-size:14.5px;background:rgba(255,255,255,.4)}",
    ".eft-empty b{display:block;color:var(--eft-ink);font-size:16px;margin-bottom:4px;font-weight:650}",
    ".eft-cat-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:0 0 16px}",
    ".eft-cat-head h2{margin:0;font-size:22px;font-weight:700;letter-spacing:-.02em}.eft-cat-head p{margin:4px 0 0;color:var(--eft-ink3);font-size:14.5px;font-weight:300}",
    ".eft-cat{margin:8px 0 40px}",
    /* dialog */
    ".eft-scrim{position:fixed;inset:0;z-index:2147482000;background:rgba(24,34,54,.38);display:flex;align-items:center;justify-content:center;padding:3vh 20px;animation:eft-fade .2s ease}",
    "@keyframes eft-fade{from{opacity:0}}@keyframes eft-rise{from{opacity:0;transform:translateY(12px)}}",
    ".eft-dlg{position:relative;width:100%;max-width:480px;max-height:94vh;overflow:auto;background:#fff;border-radius:24px;box-shadow:0 40px 90px -30px rgba(24,34,54,.45);animation:eft-rise .26s var(--ease,ease)}",
    ".eft-dlg-top{padding:32px 32px 0}",
    ".eft-x{position:absolute;right:14px;top:14px;width:36px;height:36px;border-radius:50%;border:0;background:transparent;cursor:pointer;display:grid;place-items:center;color:var(--eft-ink3)}",
    ".eft-x:hover{background:rgba(20,27,41,.06);color:var(--eft-ink)}.eft-x svg{width:18px;height:18px}",
    ".eft-eyebrow{margin:0 0 6px;font-size:12.5px;font-weight:600;color:var(--eft-blue)}",
    ".eft-dlg h3{margin:0 40px 4px 0;font-size:21px;font-weight:700;letter-spacing:-.02em;line-height:1.25}",
    ".eft-dlg-when{margin:0;font-size:14.5px;color:var(--eft-ink3)}",
    ".eft-dlg .eft-agenda{margin-top:18px}.eft-dlg .eft-host{margin-top:14px}",
    ".eft-dlg-cta{padding:24px 32px 30px}.eft-dlg-cta .eft-btn{width:100%}",
    /* form: one column, known data collapsed, optional behind links */
    ".eft-form{padding:24px 32px 30px;display:flex;flex-direction:column;gap:18px}",
    ".eft-who{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 0 18px;border-bottom:1px solid rgba(20,27,41,.08)}",
    ".eft-who div{min-width:0;font-size:14.5px;line-height:1.45}.eft-who small{display:block;font-size:12.5px;color:var(--eft-ink3)}",
    ".eft-who b{display:block;font-weight:600;color:var(--eft-ink)}.eft-who .eml{display:block;color:var(--eft-ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".eft-link{appearance:none;border:0;background:none;padding:4px 0;font:inherit;font-size:14px;font-weight:600;color:var(--eft-blue);cursor:pointer;white-space:nowrap}",
    ".eft-link:hover{color:var(--eft-deep);text-decoration:underline;text-underline-offset:3px}",
    ".eft-pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}",
    ".eft-idf{display:flex;flex-direction:column;gap:18px}",
    ".eft-f label{display:block;font-size:13px;font-weight:600;color:var(--eft-ink2);margin-bottom:6px}",
    ".eft-f label em{font-style:normal;font-weight:400;color:var(--eft-ink3)}",
    ".eft .eft-f input,.eft .eft-f textarea{display:block;width:100%;font:inherit;font-size:15.5px;color:var(--eft-ink);background:#fff;border:1px solid rgba(20,27,41,.16);border-radius:12px;padding:11px 13px;outline:0;box-shadow:none;transition:border-color .15s,box-shadow .15s}",
    ".eft .eft-f textarea{resize:vertical;min-height:84px;line-height:1.45}",
    ".eft .eft-f input:focus,.eft .eft-f textarea:focus,.eft .eft-f input:focus-visible,.eft .eft-f textarea:focus-visible{outline:0;border-color:var(--eft-blue);box-shadow:0 0 0 3px rgba(69,104,169,.16)}",
    ".eft .eft-f.bad input{border-color:var(--eft-rasp)}.eft-f .err{display:none;font-size:12.5px;color:var(--eft-rasp);margin-top:6px}.eft-f.bad .err{display:block}",
    ".eft-list-c{margin:6px 0 0;padding:6px;list-style:none;background:#fff;border:1px solid rgba(20,27,41,.12);border-radius:14px;box-shadow:0 18px 40px -24px rgba(24,34,54,.35);max-height:240px;overflow:auto}",
    ".eft-list-c li{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:10px;cursor:pointer;font-size:15px;line-height:1.35}",
    ".eft-list-c li .c{font-size:12.5px;color:var(--eft-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}",
    ".eft-list-c li[aria-selected=true],.eft-list-c li:hover{background:rgba(69,104,169,.07)}",
    ".eft-list-c li.add{color:var(--eft-blue);font-weight:600}.eft-list-c li.empty{color:var(--eft-ink3);cursor:default;background:none}",
    ".eft-list-c mark{background:none;color:inherit;font-weight:700}",
    ".eft-newtag{margin:6px 0 0;font-size:12.5px;color:var(--eft-ink3)}",
    ".eft-extra{display:flex;flex-wrap:wrap;gap:4px 22px;margin-top:-6px}",
    ".eft-submit{width:100%;margin-top:4px}",
    ".eft-fine{margin:-6px 0 0;font-size:12.5px;color:var(--eft-ink3);text-align:center}",
    /* done */
    ".eft-ok{padding:40px 32px 32px;text-align:center}",
    ".eft-ok .ring{width:56px;height:56px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;background:rgba(33,185,170,.12);color:var(--eft-teal);flex:none}",
    ".eft-ok .ring svg{width:26px;height:26px}",
    ".eft-ok h3{margin:0 0 6px;font-size:21px}",
    ".eft-ok p{margin:0 auto;max-width:36ch;color:var(--eft-ink2);font-size:15px;line-height:1.55}",
    ".eft-ok .small{font-size:13px;color:var(--eft-ink3);margin-top:10px}",
    ".eft-ok .eft-btn{margin-top:22px;min-width:160px}",
    "@media(max-width:820px){.eft-card{grid-template-columns:84px 1fr;gap:18px;padding:22px;align-items:start}.eft-date{width:84px;height:84px;border-radius:20px}",
    ".eft-date b{font-size:32px}.eft-date i{display:none}.eft-act{grid-column:1/-1;flex-direction:row;flex-wrap:wrap;align-items:center}.eft-act .eft-btn{flex:1 1 auto}.eft-seats{text-align:left}}",
    ".eft-mhead{display:none}",
    "@media(max-width:640px){.eft-card{grid-template-columns:1fr;gap:16px;padding:20px 20px 18px}.eft-date{display:none}.eft-time{display:none}",
    ".eft-mhead{display:flex;align-items:center;gap:12px;margin-bottom:14px}",
    ".eft-mdate{position:relative;flex:none;width:52px;height:52px;border-radius:14px;background:#fff;box-shadow:0 1px 2px rgba(24,34,54,.05),0 10px 22px -14px rgba(44,74,133,.4);display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;overflow:hidden}",
    ".eft-mdate::before{content:'';position:absolute;left:0;right:0;top:0;height:4px;background:var(--eft-grad)}",
    ".eft-mdate b{font-size:21px;font-weight:700;letter-spacing:-.03em;color:var(--eft-ink)}.eft-mdate span{font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--eft-blue);margin-top:3px}",
    ".eft-mwhen{min-width:0;line-height:1.35}.eft-mwhen b{display:block;font-size:14.5px;font-weight:650;color:var(--eft-ink)}",
    ".eft-mwhen span{display:block;font-size:14px;color:var(--eft-ink2)}.eft-mwhen small{display:block;font-size:12px;color:var(--eft-ink3)}",
    ".eft-meta{margin-bottom:4px}.eft-mod{background:none;padding:0;border-radius:0;font-size:12.5px;letter-spacing:0;color:var(--eft-blue)}",
    ".eft-title{font-size:19px;margin-bottom:0}.eft-agenda{margin-top:12px}.eft-agenda li{font-size:14px}.eft-host{margin-top:12px}",
    ".eft-act{grid-column:1;display:grid;grid-template-columns:1fr auto;align-items:center;gap:6px 12px;min-width:0}",
    ".eft-act .eft-btn,.eft-act .eft-done{grid-column:1/-1;width:100%}.eft-act .eft-seats{grid-column:1;text-align:left}.eft-act .eft-ghost{grid-column:2;justify-self:end;padding:8px 4px}",
    ".eft-card::before{width:260px;height:260px;right:-120px;top:-140px}}",
    "@media(max-width:560px){.eft-pair{grid-template-columns:1fr}.eft-dlg-top{padding:28px 22px 0}.eft-form,.eft-dlg-cta{padding:22px 22px 26px}",
    ".eft-scrim{padding:0;align-items:flex-end}.eft-dlg{max-height:94vh;border-radius:22px 22px 0 0}.eft-row{grid-template-columns:52px 1fr;}.eft-row .eft-ghost{grid-column:2;justify-self:start;padding-left:0}}",
    "@media(prefers-reduced-motion:reduce){.eft-scrim,.eft-dlg{animation:none}.eft-flag.live::before{animation:none}}"
  ].join("");
  function injectCss() {
    if (document.getElementById("eft-css")) return;
    var st = document.createElement("style"); st.id = "eft-css"; st.textContent = CSS;
    document.head.appendChild(st);
  }

  var ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
  };

  /* ------------------------------------------------------------ state */
  var S = { data: null, me: null, now: Date.now() };
  function sessions() {
    var list = (S.data && S.data.sessions) || [];
    return list.filter(function (s) { return phase(s, S.now) !== "past"; })
      .sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
  }
  function isRegistered(s) { return !!lsGet(regKey(S.me && S.me.id, s.id)); }
  function endpoint() { return (S.data && S.data.endpoint) || CFG.trainingEndpoint || ""; }

  /* ------------------------------------------------------------ render: pieces */
  function agendaHtml(items, max) {
    items = items || []; if (!items.length) return "";
    var shown = max ? items.slice(0, max) : items;
    var out = shown.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("");
    if (max && items.length > max) out += '<li class="more">+ ' + (items.length - max) + " more</li>";
    return '<ul class="eft-agenda">' + out + "</ul>";
  }
  function flagHtml(s) {
    var p = phase(s, S.now);
    if (p === "live") return '<span class="eft-flag live">Starting now</span>';
    if (p === "soon") return '<span class="eft-flag">' + esc(relDays(s, S.now).replace(/^./, function (c) { return c.toUpperCase(); })) + "</span>";
    return "";
  }
  function actionHtml(s) {
    if (isRegistered(s)) {
      return '<div class="eft-done">' + ICON.check + "You’re registered</div>" +
        '<button type="button" class="eft-ghost" data-eft-open="' + esc(s.id) + '">Details</button>';
    }
    var full = s.seatsLeft === 0;
    var seats = "";
    /* seats stay quiet: nothing unless the session is nearly full (anyone may join, the limit is a backstop) */
    if (s.capacity != null && s.seatsLeft != null && s.seatsLeft <= 5) {
      seats = full ? '<div class="eft-seats low">Fully booked</div>'
        : '<div class="eft-seats low">' + (s.seatsLeft === 1 ? "Last seat" : "Only " + s.seatsLeft + " seats left") + "</div>";
    }
    return '<button type="button" class="eft-btn" data-eft-reg="' + esc(s.id) + '"' + (full ? " disabled" : "") + ">Register</button>" +
      seats + '<button type="button" class="eft-ghost" data-eft-open="' + esc(s.id) + '">Details</button>';
  }
  function cardHtml(s) {
    var w = when(s);
    return '<article class="eft-card">' +
      '<div class="eft-date" aria-hidden="true"><b>' + esc(w.day) + "</b><span>" + esc(w.mon) + "</span><i>" + esc(w.wd) + "</i></div>" +
      '<div class="eft-body">' +
        /* phone header: small date tile + weekday and time, replaces the big tile */
        '<div class="eft-mhead" aria-hidden="true"><div class="eft-mdate"><b>' + esc(w.day) + "</b><span>" + esc(w.mon) + "</span></div>" +
          '<div class="eft-mwhen"><b>' + esc(w.wd) + "</b><span>" + esc(w.same ? w.org : w.local + " your time") + "</span>" +
          (w.same ? "" : "<small>" + esc(w.org) + "</small>") + "</div></div>" +
        '<div class="eft-meta"><span class="eft-mod">' + esc(s.module) + "</span>" + flagHtml(s) + "</div>" +
        '<h3 class="eft-title">' + esc(s.title) + "</h3>" +
        '<p class="eft-time">' + esc(w.dateLong) + " · " + esc(w.same ? w.org : w.local + " your time") +
          (w.same ? "" : "<small>" + esc(w.org) + " · shown in " + esc(w.tzCity) + " time</small>") + "</p>" +
        agendaHtml(s.agenda, 3) +
        (s.host ? '<div class="eft-host">With ' + esc(s.host) + " · on Zoom</div>" : '<div class="eft-host">On Zoom</div>') +
      "</div>" +
      '<div class="eft-act">' + actionHtml(s) + "</div>" +
    "</article>";
  }
  function rowHtml(s) {
    var w = when(s);
    return '<div class="eft-row"><div class="d"><b>' + esc(w.day) + "</b><span>" + esc(w.mon) + "</span></div>" +
      "<div><h4>" + esc(s.title) + "</h4><p>" + esc(s.module) + " · " + esc(w.same ? w.org : w.local + " your time") + "</p></div>" +
      '<button type="button" class="eft-ghost" data-eft-open="' + esc(s.id) + '">' + (isRegistered(s) ? "✓ Registered" : "Details & register") + "</button></div>";
  }

  /* ------------------------------------------------------------ render: mounts */
  function renderHome(el) {
    var list = sessions();
    var section = el.closest ? el.closest("[data-eft-section]") : null;
    if (!list.length) { el.innerHTML = ""; if (section) section.hidden = true; return; }
    if (section) section.hidden = false;
    var more = list.slice(1, 3);
    el.innerHTML = '<div class="eft">' + cardHtml(list[0]) +
      (more.length ? '<div class="eft-list">' + more.map(rowHtml).join("") + "</div>" : "") + "</div>";
  }
  function renderCat(el) {
    var list = sessions();
    var body = list.length
      ? cardHtml(list[0]) + (list.length > 1 ? '<div class="eft-list">' + list.slice(1).map(rowHtml).join("") + "</div>" : "")
      : '<div class="eft-empty"><b>No live sessions scheduled right now</b>New dates appear here as soon as the team publishes them. ' +
        "Questions in the meantime: <a href=\"mailto:" + CONTACT + '">' + CONTACT + "</a></div>";
    /* staff only: a quiet link to the internal form (the page itself is also locked to efferon.com) */
    var staff = S.me && /@efferon\.com$/i.test(String(S.me.email || "")) && /^https:\/\//.test(CFG.trainingAdminUrl || "");
    el.innerHTML = '<div class="eft eft-cat"><div class="eft-cat-head"><div><h2>Live training sessions</h2></div>' +
      (staff ? '<a class="eft-link" href="' + esc(CFG.trainingAdminUrl) + '" target="_blank" rel="noopener">Manage sessions \u2192</a>' : "") +
      "</div>" + body + "</div>";
  }
  function renderAll() {
    var h = document.getElementById("efr-training-home"); if (h) renderHome(h);
    var c = document.getElementById("efr-training-cat"); if (c) renderCat(c);
  }

  /* ------------------------------------------------------------ registration
     Form rules (why it looks like this):
       - ask only what we don't know: a known name + e-mail collapse into one
         "Registering as" line with Change; company is the only open field;
       - one column, labels above, no placeholder hints, no per-field badges;
       - optional things (a colleague, a note) stay behind two quiet links;
       - one primary button; errors appear only after submit, one line each. */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var dlg = null, lastFocus = null;

  function closeDlg() {
    if (!dlg) return;
    dlg.remove(); dlg = null; document.documentElement.style.overflow = "";
    document.removeEventListener("keydown", onKey, true);
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  }
  function onKey(e) {
    if (e.key === "Escape") {
      if (e.target && e.target.getAttribute && e.target.getAttribute("aria-expanded") === "true") return; /* the list closes first */
      e.preventDefault(); closeDlg(); return;
    }
    if (e.key === "Tab" && dlg) {
      var f = [].filter.call(dlg.querySelectorAll("button,input,textarea,a[href]"), function (x) { return x.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function splitName(n) {
    n = String(n || "").trim().replace(/\s+/g, " ");
    if (!n || /@/.test(n)) return ["", ""];
    var i = n.indexOf(" "); return i < 0 ? [n, ""] : [n.slice(0, i), n.slice(i + 1)];
  }
  function findSession(id) { return sessions().filter(function (x) { return x.id === id; })[0]; }
  function whenLine(s) { var w = when(s); return w.dateLong + " · " + (w.same ? w.org : w.local + " your time (" + w.org + ")"); }

  /* company: the profile's Zendesk organisation (name from the payload's orgs map,
     because /users/me gives an end user only the id) > what this person typed last
     time in this browser (per user, so a shared computer doesn't leak it) > empty */
  var FIELDS = ["first_name", "last_name", "email", "company", "alt_email", "comment"];
  function companyKey() { return LS_COMPANY + "_" + ((S.me && S.me.id) || "anon"); }
  function orgName() {
    var me = S.me || {}, orgs = (S.data && S.data.orgs) || {};
    var v = me.organization_id != null ? orgs[String(me.organization_id)] : "";
    return typeof v === "string" ? v.trim() : "";
  }
  function prefill() {
    var me = S.me || {}, nm = splitName(me.name), org = orgName(), rem = String(lsGet(companyKey()) || "").trim();
    return { first_name: nm[0], last_name: nm[1], email: String(me.email || "").trim(), company: org || rem,
      companySource: org ? "profile" : rem ? "remembered" : "" };
  }
  function known(p) { return !!(p.first_name && p.last_name && EMAIL_RE.test(p.email)); }
  function companyKnown(p) { return p.companySource === "profile" && !!p.company; }

  /* company list (same matching as the access-request form) */
  function cnorm(x) { return String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
  function companyList() {
    var seen = {}, raw = (S.data && S.data.companies) || [];
    return (Array.isArray(raw) ? raw : []).filter(function (c) {
      var k = c && typeof c.name === "string" ? cnorm(c.name) : ""; if (!k || seen[k]) return false; seen[k] = 1; return true;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function listedMatch(v) { var n = cnorm(v); if (!n) return null; return companyList().filter(function (c) { return cnorm(c.name) === n; })[0] || null; }

  function field(name, label, value, o) {
    o = o || {};
    var input = o.area
      ? '<textarea id="eft-' + name + '" name="' + name + '" maxlength="1000">' + esc(value) + "</textarea>"
      : '<input id="eft-' + name + '" name="' + name + '" type="' + (o.type || "text") + '" value="' + esc(value) + '"' + (o.ac ? ' autocomplete="' + o.ac + '"' : "") + ">";
    return '<div class="eft-f" data-f="' + name + '"' + (o.hidden ? " hidden" : "") + ">" +
      '<label for="eft-' + name + '">' + esc(label) + (o.opt ? " <em>(optional)</em>" : "") + "</label>" + input +
      '<div class="err">' + esc(o.err || "Please fill this in") + "</div></div>";
  }
  function companyField(p, o) {
    o = o || {};
    return '<div class="eft-f eft-combo" data-f="company"' + (o.hidden ? " hidden" : "") + ">" +
      '<label for="eft-company">' + esc(o.label || "Company") + "</label>" +
      '<input id="eft-company" name="company" type="text" maxlength="200" value="' + esc(p.company) + '" autocomplete="off"' +
      (companyList().length ? ' role="combobox" aria-expanded="false" aria-controls="eft-company-list" aria-autocomplete="list"' : ' autocomplete="organization"') + ">" +
      '<ul class="eft-list-c" id="eft-company-list" role="listbox" hidden></ul>' +
      '<p class="eft-newtag" hidden>New company \u2014 we\u2019ll add it to our list.</p>' +
      '<div class="err">Please enter your company</div></div>';
  }
  function idFields(p) {
    return '<div class="eft-pair">' + field("first_name", "First name", p.first_name, { ac: "given-name" }) +
      field("last_name", "Last name", p.last_name, { ac: "family-name" }) + "</div>" +
      field("email", "Work e-mail", p.email, { type: "email", ac: "email", err: "Please enter a valid e-mail" });
  }
  function hiddenFields(s, p) {
    var me = S.me || {};
    return '<input type="hidden" name="action" value="register"><input type="hidden" name="session" value="' + esc(s.id) + '">' +
      '<input type="hidden" name="zd_user_id" value="' + esc(me.id || "") + '"><input type="hidden" name="zd_email" value="' + esc(me.email || "") + '">' +
      '<input type="hidden" name="company_listed" value=""><input type="hidden" name="company_source" value="' + esc(p.companySource) + '">' +
      '<input type="hidden" name="prefill_edited" value=""><input type="hidden" name="return_url" value="' + esc(location.href.split("#")[0]) + '">';
  }
  function formOpen() { var ep = endpoint(); return '<form class="eft-form" method="post" target="_blank" novalidate' + (ep ? ' action="' + esc(ep) + '"' : "") + ">"; }
  function submitBtn() {
    var ep = endpoint();
    return '<button type="submit" class="eft-btn eft-submit"' + (ep ? "" : ' disabled title="Registration endpoint not configured yet"') + ">Register</button>";
  }

  /* compact form - variants a and b */
  function compactForm(s, p) {
    var k = known(p), ck = k && companyKnown(p);
    return formOpen() +
      (k ? '<div class="eft-who"><div><small>Registering as</small><b>' + esc(p.first_name + " " + p.last_name) + '</b><span class="eml">' + esc(p.email) + "</span>" +
           (ck ? '<span class="eml">' + esc(p.company) + "</span>" : "") + "</div>" +
           '<button type="button" class="eft-link" data-eft-change>Change</button></div>' : "") +
      '<div class="eft-idf"' + (k ? " hidden" : "") + ">" + idFields(p) + "</div>" +
      companyField(p, { hidden: ck }) +
      '<div class="eft-extra"><button type="button" class="eft-link" data-eft-more="alt_email">+ Invite a colleague</button>' +
        '<button type="button" class="eft-link" data-eft-more="comment">+ Add a note</button></div>' +
      field("alt_email", "Colleague’s e-mail", "", { type: "email", opt: 1, hidden: 1, err: "This doesn’t look like an e-mail" }) +
      field("comment", "Note for the team", "", { area: 1, opt: 1, hidden: 1 }) +
      hiddenFields(s, p) + submitBtn() +
      '<p class="eft-fine">Only the Efferon training team sees these details.</p></form>';
  }
  function headHtml(s, full) {
    return '<div class="eft-dlg-top"><p class="eft-eyebrow">' + esc(s.module) + "</p>" +
      '<h3 id="eft-dlg-title">' + esc(s.title) + '</h3><p class="eft-dlg-when">' + esc(whenLine(s)) + "</p>" +
      (full ? agendaHtml(s.agenda) + (s.host ? '<div class="eft-host">With ' + esc(s.host) + " · on Zoom</div>" : '<div class="eft-host">On Zoom</div>') : "") + "</div>";
  }
  function stateHtml(s) {
    if (isRegistered(s)) return doneHtml(s, { email: lsGet(regKey(S.me && S.me.id, s.id)) }, "shown");
    if (s.seatsLeft === 0) return '<div class="eft-ok"><h3>Fully booked</h3><p>Write to <a href="mailto:' + CONTACT + "?subject=" +
      encodeURIComponent("Waiting list: " + s.title) + '">' + CONTACT + "</a> and we’ll tell you if a seat opens up.</p></div>";
    if (!S.me) return '<div class="eft-ok"><h3>Sign in to register</h3><p>Registration uses your portal account.</p></div>';
    return "";
  }

  /* view: "details" (agenda + Register button) or "form" */
  function openDlg(id, view) {
    var s = findSession(id); if (!s) return;
    if (!dlg) lastFocus = document.activeElement;
    closeDlgSilently();
    var p = prefill(), st = stateHtml(s), body;
    if (st) body = headHtml(s, view === "details") + st;
    else if (view === "details") body = headHtml(s, true) + '<div class="eft-dlg-cta"><button type="button" class="eft-btn" data-eft-toform="' + esc(s.id) + '">Register</button></div>';
    else body = headHtml(s, false) + compactForm(s, p);

    dlg = document.createElement("div");
    dlg.className = "eft eft-scrim";
    dlg.innerHTML = '<div class="eft-dlg" role="dialog" aria-modal="true" aria-labelledby="eft-dlg-title">' +
      '<button type="button" class="eft-x" aria-label="Close">' + ICON.x + "</button>" + body + "</div>";
    document.body.appendChild(dlg);
    document.documentElement.style.overflow = "hidden";
    document.addEventListener("keydown", onKey, true);
    dlg.addEventListener("mousedown", function (e) { if (e.target === dlg) closeDlg(); });
    dlg.querySelector(".eft-x").addEventListener("click", closeDlg);
    var tf = dlg.querySelector("[data-eft-toform]");
    if (tf) tf.addEventListener("click", function () { openDlg(s.id, "form"); });
    var form = dlg.querySelector("form");
    if (form) wireForm(form, s, p, dlg);
    setTimeout(function () { focusFirst(form) || (tf && tf.focus()) || dlg.querySelector(".eft-x").focus(); }, 30);
  }
  function closeDlgSilently() { if (dlg) { dlg.remove(); dlg = null; } }
  function focusFirst(form) {
    if (!form) return false;
    var vis = [].filter.call(form.querySelectorAll("input:not([type=hidden]),textarea"), function (x) { return x.offsetParent !== null; });
    var empty = vis.filter(function (x) { return x.tagName !== "BUTTON" && !x.value; })[0];
    var t = empty || vis[0]; if (t) { t.focus(); return true; } return false;
  }

  function wireForm(form, s, pre, host) {
    var ch = form.querySelector("[data-eft-change]");
    if (ch) ch.addEventListener("click", function () {
      var who = form.querySelector(".eft-who"), idf = form.querySelector(".eft-idf");
      if (who) who.hidden = true; ch.hidden = true; idf.hidden = false;
      var cf = form.querySelector('.eft-combo'); if (cf) cf.hidden = false;
      idf.querySelector("input").focus();
    });
    [].forEach.call(form.querySelectorAll("[data-eft-more]"), function (b) {
      b.addEventListener("click", function () {
        var f = form.querySelector('[data-f="' + b.getAttribute("data-eft-more") + '"]');
        f.hidden = false; b.hidden = true; f.querySelector("input,textarea").focus();
      });
    });
    form.addEventListener("input", function (e) { var f = e.target.closest(".eft-f"); if (f) f.classList.remove("bad"); });
    var combo = wireCombo(form);

    function val(k) { return form.elements[k] ? form.elements[k].value.trim() : ""; }
    function check(keys) {
      var bad = [];
      keys.forEach(function (k) {
        var v = val(k);
        if (k === "email") { if (!EMAIL_RE.test(v)) bad.push(k); }
        else if (k === "alt_email") { if (v && (!EMAIL_RE.test(v) || v.toLowerCase() === val("email").toLowerCase())) bad.push(k); }
        else if (k !== "comment" && !v) bad.push(k);
      });
      keys.forEach(function (k) { var f = form.querySelector('[data-f="' + k + '"]'); if (f) f.classList.toggle("bad", bad.indexOf(k) >= 0); });
      if (bad.length) {
        var idf = form.querySelector(".eft-idf");
        if (idf && idf.hidden && /first_name|last_name|email/.test(bad.join(" ")) && bad.indexOf("alt_email") < 0) { var c = form.querySelector("[data-eft-change]"); if (c) c.click(); }
        var extra = form.querySelector('[data-f="' + bad[0] + '"]'); if (extra && extra.hidden) extra.hidden = false;
        var el = form.elements[bad[0]]; if (el) el.focus();
      }
      return !bad.length;
    }
    form.addEventListener("submit", function (e) {
      if (combo) combo.commit();
      if (!check(["first_name", "last_name", "email", "company", "alt_email", "comment"])) {
        e.preventDefault();
        return;
      }
      var v = {}; FIELDS.forEach(function (k) { v[k] = val(k).replace(/\s+/g, k === "comment" ? "$&" : " "); form.elements[k].value = v[k]; });
      form.elements.prefill_edited.value = ["first_name", "last_name", "email", "company"].filter(function (k) { return pre[k] && pre[k] !== v[k]; }).join(",");
      var hit = listedMatch(v.company);
      form.elements.company_listed.value = companyList().length ? (hit ? "yes" : "no") : "";
      form.elements.company_source.value = v.company === pre.company && pre.companySource ? pre.companySource : (combo && combo.picked() === v.company ? "list" : (hit ? "list" : "typed"));
      lsSet(companyKey(), v.company);
      var done = function (outcome) {
        if (outcome !== "full" && outcome !== "closed") lsSet(regKey(S.me && S.me.id, s.id), v.email);
        if (!dlg) return;
        var target = dlg.querySelector(".eft-dlg");
        var top = target.querySelector(".eft-dlg-top");
        target.querySelector("form").outerHTML = doneHtml(s, v, outcome);
        if (top && outcome !== "full") top.remove();
        var c = target.querySelector("[data-eft-close]"); if (c) { c.addEventListener("click", closeDlg); c.focus(); }
        renderAll();
      };
      if (typeof CFG.trainingSubmit === "function") {
        e.preventDefault();
        var fields = {}; [].forEach.call(form.elements, function (el) { if (el.name) fields[el.name] = el.value; });
        var r = CFG.trainingSubmit(fields, s) || {};
        done(r.outcome || "registered");
        return;
      }
      /* the native POST leaves into a new tab; paint the done state right after it goes */
      setTimeout(function () { done(null); }, 0);
    });
  }

  /* combobox: filter by name or country, "+ Add ... as a new company" when nothing matches exactly */
  function wireCombo(form) {
    var input = form.querySelector("#eft-company"), all = companyList();
    if (!input || !all.length) return null;
    var box = input.closest(".eft-combo"), ul = box.querySelector(".eft-list-c"), tag = box.querySelector(".eft-newtag");
    var items = [], active = -1, picked = null;
    function hi(name, q) {
      if (!q) return esc(name);
      var i = name.toLowerCase().indexOf(q.toLowerCase());
      return i < 0 ? esc(name) : esc(name.slice(0, i)) + "<mark>" + esc(name.slice(i, i + q.length)) + "</mark>" + esc(name.slice(i + q.length));
    }
    function render() {
      var q = input.value.trim(), nq = cnorm(q);
      /* name: anywhere; country: from the start of a word only ("me" must not find Armenia) */
      var hits = all.filter(function (c) { return !nq || cnorm(c.name).indexOf(nq) >= 0 || (" " + cnorm(c.country)).indexOf(" " + nq) >= 0; });
      var exact = !!listedMatch(q);
      items = hits.map(function (c) { return { name: c.name, html: "<span>" + hi(c.name, q) + '</span><span class="c">' + esc(c.country || "") + "</span>" }; });
      if (q && !exact) items.push({ name: q, isNew: true, html: "+ Add \u201c" + esc(q) + "\u201d as a new company" });
      ul.innerHTML = items.length ? items.map(function (it, i) {
        return '<li role="option" id="eft-opt' + i + '" class="' + (it.isNew ? "add" : "") + '" aria-selected="' + (i === active) + '">' + it.html + "</li>";
      }).join("") : '<li class="empty">Type your company name</li>';
    }
    function isOpen() { return !ul.hidden; }
    function open() { if (isOpen()) return; ul.hidden = false; input.setAttribute("aria-expanded", "true"); }
    function close() { ul.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; }
    function pick(it) {
      input.value = it.name; picked = it.isNew ? null : it.name;
      tag.hidden = !it.isNew; box.classList.remove("bad"); close();
    }
    function commit() {   /* typed without choosing: an exact name becomes the listed spelling */
      if (isOpen()) close();
      var v = input.value.trim().replace(/\s+/g, " "); if (!v) { tag.hidden = true; picked = null; return; }
      var m = listedMatch(v);
      if (m) { input.value = m.name; picked = m.name; tag.hidden = true; } else { input.value = v; picked = null; tag.hidden = false; }
    }
    /* opens on a tap/click or typing, not on any focus - so a validation focus doesn't cover its own error */
    input.addEventListener("mousedown", function () { active = -1; render(); open(); });
    input.addEventListener("input", function () { picked = null; tag.hidden = true; active = -1; render(); open(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); if (!isOpen()) { render(); open(); } if (!items.length) return;
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; render();
        input.setAttribute("aria-activedescendant", "eft-opt" + active);
        var el = ul.querySelector("#eft-opt" + active); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && isOpen() && active >= 0) { e.preventDefault(); e.stopPropagation(); pick(items[active]); }
      else if (e.key === "Escape" && isOpen()) { e.preventDefault(); close(); }
      else if (e.key === "Tab" && isOpen()) { commit(); }
    });
    ul.addEventListener("mousedown", function (e) {   /* mousedown beats the input's blur */
      var li = e.target.closest("li[role=option]"); if (!li) return;
      e.preventDefault(); pick(items[+li.id.replace("eft-opt", "")]);
    });
    input.addEventListener("blur", function () { setTimeout(function () { if (document.activeElement !== input) commit(); }, 0); });
    if (input.value) { var m0 = listedMatch(input.value); if (m0) { input.value = m0.name; picked = m0.name; } }
    return { commit: commit, picked: function () { return picked; } };
  }

  function doneHtml(s, v, outcome) {
    if (outcome === "full") return '<div class="eft-ok"><h3>Sorry — the last seat just went</h3><p>Write to <a href="mailto:' + CONTACT + '">' + CONTACT + "</a> to join the waiting list.</p></div>";
    var to = "<b>" + esc(v.email) + "</b>" + (v.alt_email ? " and <b>" + esc(v.alt_email) + "</b>" : "");
    var h = outcome === "already" ? "You were already registered" : outcome === "shown" ? "You’re registered" : "You’re registered" + (v.first_name ? ", " + esc(v.first_name) : "");
    return '<div class="eft-ok"><div class="ring">' + ICON.check + "</div><div>" +
      "<h3>" + h + "</h3>" +
      "<p>" + (outcome === "shown" ? "The calendar invite with the Zoom link went to " + to + "." : "We’re sending the calendar invite with the Zoom link to " + to + ".") + "</p>" +
      '<p class="small">Nothing after 10 minutes? Write to <a href="mailto:' + CONTACT + '">' + CONTACT + "</a>.</p>" +
      '<button type="button" class="eft-btn" data-eft-close>Done</button></div></div>';
  }
  /* ------------------------------------------------------------ boot */
  function ensureCatMount() {
    if (document.getElementById("efr-training-cat") || !CFG.trainingCategory) return;
    if (!new RegExp("/categories/" + CFG.trainingCategory + "(\\D|$)").test(location.pathname)) return;
    var host = document.querySelector(".category-content, #main-content, main");
    if (!host) return;
    var m = document.createElement("div"); m.id = "efr-training-cat";
    var head = host.querySelector(".page-header, h1");
    if (head && head.parentNode === host) head.insertAdjacentElement("afterend", m); else host.insertBefore(m, host.firstChild);
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-eft-reg],[data-eft-open]");
    if (!t) return;
    e.preventDefault();
    if (t.hasAttribute("data-eft-reg")) openDlg(t.getAttribute("data-eft-reg"), "form");
    else openDlg(t.getAttribute("data-eft-open"), "details");
  });

  function boot() {
    ensureCatMount();
    if (!document.getElementById("efr-training-home") && !document.getElementById("efr-training-cat")) return;
    injectCss();
    Promise.all([loadPayload(), loadMe()]).then(function (r) {
      S.data = r[0]; S.me = r[1]; S.now = Date.now();
      renderAll();
    });
  }
  /* public for the sandbox: re-read the data after it changes */
  window.EfferonTraining = {
    refresh: function () { CFG = window.EFFERON || {}; closeDlg(); boot(); },
    _when: when
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
