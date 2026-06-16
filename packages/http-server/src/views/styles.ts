/**
 * One inline CSS string for the entire operator UI. Boring on purpose.
 */

export const STYLES = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;background:#f7f8fa}
a{color:#0066cc;text-decoration:none}
a:hover{text-decoration:underline}
header{background:#1a1a2e;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.3px}
header nav a{color:#cfd3da;margin-left:18px;font-size:13px}
header nav a:hover{color:#fff;text-decoration:none}
header nav a.active{color:#fff;border-bottom:2px solid #f08000;padding-bottom:2px}
main{max-width:1024px;margin:0 auto;padding:32px 24px}
.card{background:#fff;border:1px solid #e3e6eb;border-radius:6px;padding:20px;margin-bottom:20px}
.card h2{font-size:16px;margin:0 0 12px;font-weight:600}
.card p{margin:0 0 10px}
.muted{color:#6b7280;font-size:13px}
.token-box{background:#0d1117;color:#e6edf3;padding:14px 16px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all;white-space:pre-wrap;position:relative}
.token-box .copy{position:absolute;top:6px;right:6px;background:#22272e;color:#cfd3da;border:1px solid #444c56;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px}
.token-box .copy:hover{background:#2d333b}
table{border-collapse:collapse;width:100%}
th,td{padding:8px 10px;border-bottom:1px solid #eef0f4;text-align:left;font-size:13px;vertical-align:top}
th{font-weight:600;color:#465160;background:#f4f6f9}
tr:hover td{background:#fafbfd}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:uppercase}
.badge-ok{background:#dcfce7;color:#166534}
.badge-error{background:#fee2e2;color:#991b1b}
.badge-rejected{background:#fef3c7;color:#92400e}
.btn{display:inline-block;padding:8px 14px;border-radius:5px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid #d1d5db;background:#fff;color:#1a1a1a;text-decoration:none}
.btn:hover{background:#f4f6f9;text-decoration:none}
.btn-primary{background:#0066cc;color:#fff;border-color:#0066cc}
.btn-primary:hover{background:#0052a3}
.btn-danger{background:#dc2626;color:#fff;border-color:#dc2626}
.btn-danger:hover{background:#b91c1c}
.btn-small{padding:4px 10px;font-size:12px}
form.inline{display:inline}
.error-panel{background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d;padding:16px;border-radius:6px;margin-bottom:16px}
.success-panel{background:#f0fdf4;border:1px solid #bbf7d0;color:#14532d;padding:16px;border-radius:6px;margin-bottom:16px}
pre{background:#0d1117;color:#e6edf3;padding:14px;border-radius:6px;overflow-x:auto;font-size:12.5px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#eef1f5;padding:1px 5px;border-radius:3px}
pre code{background:transparent;padding:0}
.pagination{margin-top:16px;display:flex;gap:8px;align-items:center}
.filters{margin-bottom:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:end}
.filters label{font-size:12px;color:#465160;display:block;margin-bottom:3px}
.filters input,.filters select{padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:13px}
.row{display:flex;gap:18px;align-items:flex-start}
.row > * {flex:1}
footer{text-align:center;color:#9aa3b2;font-size:12px;padding:24px 0}
.kv{display:grid;grid-template-columns:160px 1fr;gap:6px 14px;font-size:13px}
.kv dt{color:#6b7280;font-weight:500}
.kv dd{margin:0}
.deny-id{background:#f4f6f9;padding:12px 16px;border-radius:6px;margin:14px 0}
`;
