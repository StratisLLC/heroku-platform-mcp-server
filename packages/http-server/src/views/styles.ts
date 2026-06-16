/**
 * One inline CSS string for the entire operator UI.
 *
 * Visual identity mirrors the Stratis-branded quickstart at docs/index.html:
 * Salesforce Lightning Design System palette, Inter + JetBrains Mono, a navy
 * gradient header, white cards on a light-gray surface. Server-rendered HTML —
 * no framework, no CSS toolkit, intentionally inline.
 *
 * The `@import` for Google Fonts MUST stay the first declaration: the CSS spec
 * requires `@import` rules to precede all other rules. We can't add a `<link>`
 * because layout() emits a single inline `<style>` block.
 */

export const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root{
  --sfdc-brand:#0176D3;
  --sfdc-brand-dark:#014486;
  --sfdc-brand-darker:#032D60;
  --sfdc-accent:#0D9DDA;
  --sfdc-bg:#F3F3F3;
  --sfdc-surface:#FFFFFF;
  --sfdc-border:#DDDBDA;
  --sfdc-border-strong:#C9C7C5;
  --sfdc-text:#181818;
  --sfdc-text-secondary:#514F4D;
  --sfdc-text-tertiary:#706E6B;
  --sfdc-success:#2E844A;
  --sfdc-success-bg:#CDEFC4;
  --sfdc-info-bg:#EAF5FE;
  --sfdc-code-bg:#F3F2F2;
  --sfdc-error:#BA0517;
  --sfdc-error-bg:#FEDED8;
  --sfdc-warning:#8C4B02;
  --sfdc-warning-bg:#FEF1CB;
}

*,*::before,*::after{box-sizing:border-box}
*{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{margin:0;font:15px/1.55 'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--sfdc-text);background:var(--sfdc-bg)}
a{color:var(--sfdc-brand);text-decoration:none}
a:hover{text-decoration:underline}

/* ===== Site header (navy gradient) ===== */
.site-header{background:linear-gradient(135deg,#032D60 0%,#014486 50%,#0176D3 100%);color:#fff;position:relative;overflow:hidden}
.site-header::before{content:'';position:absolute;inset:0;background-image:radial-gradient(circle at 15% 0%,rgba(13,157,218,.25) 0%,transparent 40%),radial-gradient(circle at 90% 120%,rgba(1,118,211,.30) 0%,transparent 45%);pointer-events:none}
.header-inner{max-width:1024px;margin:0 auto;padding:14px 24px;display:flex;justify-content:space-between;align-items:center;gap:16px;position:relative;flex-wrap:wrap}
.brand{color:#fff;font-size:16px;font-weight:700;letter-spacing:-.01em;text-decoration:none}
.brand:hover{text-decoration:none;color:#fff}
.site-nav{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.site-nav a{color:#C9DDFB;font-size:13px;font-weight:500;padding-bottom:2px}
.site-nav a:hover{color:#fff;text-decoration:none}
.site-nav a.active{color:#fff;border-bottom:2px solid var(--sfdc-accent)}
.site-nav form.inline{display:inline}

/* ===== Main ===== */
.site-main{max-width:1024px;margin:0 auto;padding:32px 24px}

/* ===== Cards ===== */
.card{background:var(--sfdc-surface);border:1px solid var(--sfdc-border);border-radius:8px;padding:24px;margin-bottom:20px}
.card h2{font-size:20px;margin:0 0 12px;font-weight:600;letter-spacing:-.01em}
.card h3{font-size:15px;margin:0 0 10px;font-weight:600}
.card p{margin:0 0 10px;color:var(--sfdc-text-secondary)}
.card ol,.card ul{color:var(--sfdc-text-secondary);line-height:1.6}
.muted{color:var(--sfdc-text-tertiary);font-size:13px}

/* ===== Token box (stays a dark code surface for contrast) ===== */
.token-box{background:#0d1117;color:#e6edf3;padding:14px 16px;border-radius:6px;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all;white-space:pre-wrap;position:relative}
.token-box .copy{position:absolute;top:6px;right:6px;background:#22272e;color:#cfd3da;border:1px solid #444c56;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;font-family:'Inter',sans-serif}
.token-box .copy:hover{background:#2d333b}

/* ===== Tables ===== */
table{border-collapse:collapse;width:100%}
th,td{padding:9px 10px;border-bottom:1px solid #EEEDEC;text-align:left;font-size:13px;vertical-align:top}
th{font-weight:600;color:var(--sfdc-text-secondary);background:#FAFAF9}
tr:hover td{background:#FAFCFE}

/* ===== Badges ===== */
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.02em}
.badge-ok{background:var(--sfdc-success-bg);color:var(--sfdc-success)}
.badge-error{background:var(--sfdc-error-bg);color:var(--sfdc-error)}
.badge-rejected{background:var(--sfdc-warning-bg);color:var(--sfdc-warning)}

/* ===== Buttons ===== */
.btn{display:inline-block;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid var(--sfdc-border-strong);background:var(--sfdc-surface);color:var(--sfdc-text);text-decoration:none;font-family:'Inter',sans-serif}
.btn:hover{background:#F3F2F2;text-decoration:none}
.btn-primary{background:var(--sfdc-brand);color:#fff;border-color:var(--sfdc-brand)}
.btn-primary:hover{background:var(--sfdc-brand-dark);border-color:var(--sfdc-brand-dark);color:#fff}
.btn-danger{background:var(--sfdc-error);color:#fff;border-color:var(--sfdc-error)}
.btn-danger:hover{background:#8E030F;border-color:#8E030F;color:#fff}
.btn-small{padding:4px 10px;font-size:12px}
form.inline{display:inline}

/* ===== Panels ===== */
.error-panel{background:var(--sfdc-error-bg);border:1px solid #F5A09A;color:#5C0A12;padding:18px 20px;border-radius:8px;margin-bottom:16px}
.error-panel h2{margin-top:0}
.success-panel{background:var(--sfdc-success-bg);border:1px solid #91DB8B;color:#0B5323;padding:18px 20px;border-radius:8px;margin-bottom:16px}
.success-panel h2{margin-top:0}

/* ===== Code ===== */
pre{background:#0d1117;color:#e6edf3;padding:14px;border-radius:6px;overflow-x:auto;font-size:12.5px;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:var(--sfdc-code-bg);padding:1px 5px;border-radius:3px;color:var(--sfdc-brand-darker)}
pre code{background:transparent;padding:0;color:inherit}

/* ===== Misc layout helpers ===== */
.pagination{margin-top:16px;display:flex;gap:8px;align-items:center}
.filters{margin-bottom:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:end}
.filters label{font-size:12px;color:var(--sfdc-text-secondary);display:block;margin-bottom:3px}
.filters input,.filters select{padding:6px 8px;border:1px solid var(--sfdc-border-strong);border-radius:4px;font-size:13px;font-family:'Inter',sans-serif}
.row{display:flex;gap:18px;align-items:flex-start}
.row > *{flex:1}
.kv{display:grid;grid-template-columns:160px 1fr;gap:6px 14px;font-size:13px}
.kv dt{color:var(--sfdc-text-tertiary);font-weight:500}
.kv dd{margin:0}
.deny-id{background:#FAFAF9;border:1px solid var(--sfdc-border);padding:14px 16px;border-radius:6px;margin:14px 0}

/* ===== Footer ===== */
.site-footer{background:#FAFAF9;border-top:1px solid var(--sfdc-border);padding:28px 0;margin-top:48px}
.footer-inner{max-width:1024px;margin:0 auto;padding:0 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
.footer-credit{font-size:12px;color:var(--sfdc-text-tertiary);line-height:1.6}
.footer-credit strong{color:var(--sfdc-text-secondary)}
.footer-attribution{font-size:11px;color:var(--sfdc-text-tertiary);max-width:460px;line-height:1.5}

/* ===== Landing hero (page section, distinct from .site-header) ===== */
.hero{background:linear-gradient(135deg,#032D60 0%,#014486 50%,#0176D3 100%);color:#fff;border-radius:8px;padding:48px 36px;margin-bottom:24px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;inset:0;background-image:radial-gradient(circle at 20% 10%,rgba(13,157,218,.25) 0%,transparent 35%),radial-gradient(circle at 80% 90%,rgba(1,118,211,.30) 0%,transparent 40%);pointer-events:none}
.hero-inner{position:relative}
.hero-title{font-size:40px;font-weight:700;line-height:1.1;margin:0 0 16px;letter-spacing:-.02em;color:#fff}
.hero-sub{font-size:18px;color:#C9DDFB;max-width:720px;margin:0 0 24px;line-height:1.5}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#B5DAFE;margin-bottom:16px}
.eyebrow-dot{width:6px;height:6px;background:var(--sfdc-accent);border-radius:50%}
.platform-tag{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:24px;padding:6px 14px;font-size:12px;color:#fff;font-weight:500}
.platform-tag strong{font-weight:600}
.platform-tag .sep{color:rgba(255,255,255,.35);margin:0 4px}

/* ===== Landing utilities ===== */
.section-sub{color:var(--sfdc-text-secondary);font-size:15px;margin:0 0 20px}
h2 + .section-sub{margin-top:-4px}
.options-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.option-card{background:var(--sfdc-surface);border:1px solid var(--sfdc-border);border-radius:8px;padding:24px;transition:border-color .15s ease,box-shadow .15s ease}
.option-card:hover{border-color:var(--sfdc-brand);box-shadow:0 2px 12px rgba(1,118,211,.08)}
.option-card .opt-num{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--sfdc-info-bg);color:var(--sfdc-brand);font-weight:600;font-size:13px;margin-bottom:12px}
.option-card h3{margin:0 0 6px;font-size:16px;font-weight:600}
.option-card p{color:var(--sfdc-text-secondary);font-size:14px;margin:0 0 16px;line-height:1.5}
.option-card .opt-action{font-size:14px;color:var(--sfdc-brand);font-weight:500;text-decoration:none}
.option-card .opt-action:hover{text-decoration:underline}

@media (max-width:720px){
  .options-grid{grid-template-columns:1fr}
  .hero{padding:36px 24px}
  .hero-title{font-size:32px}
}
`;
