/** Reader-facing copies of the frozen proof pages; original evidence stays byte-identical. */
import { readFile, writeFile } from 'node:fs/promises';

const style = `
main{max-width:1120px;padding:48px 28px 80px}h1{max-width:900px}h2{letter-spacing:-.7px}
section{margin:56px 0}.reader-nav{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:64px}
.reader-nav a{text-decoration:none}.reader-nav a:first-child{font-weight:750;color:#edf1e6;font-size:23px;letter-spacing:-.7px}
.reader-note{color:#b6c0ad;font-size:15px}.reader-back{display:inline-flex;padding:10px 16px;border:1px solid #45513d;border-radius:7px}
details{border-top:1px solid #45513d;margin:20px 0;padding:4px 0}details details{margin:12px 0}
summary{font-weight:600}.fingerprint{font-size:15px;color:#b6c0ad}.fingerprint code{display:block;padding:16px;background:#1a2117}
.runs article{padding:18px 0}.runs img{border-radius:8px}.reader-verdict{display:flex;flex-wrap:wrap;gap:24px;font-weight:650;color:#c7f78d;font-size:20px;margin:28px 0}
@media(max-width:600px){main{padding:24px 20px 56px}.reader-nav{margin-bottom:40px}.reader-nav a:first-child{font-size:21px}.reader-back{padding:8px 12px;font-size:14px}h2{font-size:27px}}
`;

for (const directory of ['proof', 'proof/heldout']) {
  const original = await readFile(`${directory}/index.html`, 'utf8');
  const home = directory === 'proof' ? '../index.html' : '../../index.html';
  let view = original.replace('</style>', `${style}</style>`)
    .replace(/<details open>/g, '<details>')
    .replace(/<p><code>([a-f0-9]{64})<\/code><\/p>/g,
      '<details class="fingerprint"><summary>File fingerprint</summary><p>SHA-256 identifies this exact captured file.</p><code>$1</code></details>')
    .replace(/<p>Test SHA-256: ([\s\S]*?)<\/p>/g,
      '<details class="fingerprint"><summary>Test fingerprint and execution details</summary><p>SHA-256: $1</p></details>')
    .replace(/href="heldout\/index.html"/g, 'href="heldout/view.html"')
    .replace(/href="\.\.\/index.html"/g, 'href="../view.html"');
  if (directory === 'proof') {
    view = view.replace(/<section id="runtime">([\s\S]*?)<\/section>/,
      '<details id="runtime"><summary>Sandbox verification and technical details</summary>$1</details>');
    view = view.replace('<h2>The same test fails buggy and passes fixed.</h2>',
      '<h2>The same test catches the bug<br>and passes the fix.</h2><div class="reader-verdict"><span>Buggy app · test fails</span><span>Fixed app · test passes</span></div>');
  } else {
    view = view.replace('<div class="outputs">', '<details><summary>Inspect captured test output</summary><div class="outputs">')
      .replace('</pre></article></div><h2>Scope remains explicit</h2>', '</pre></article></div></details><h2>About this capture</h2>');
  }
  view = view.replace('<main>', `<main><nav class="reader-nav" aria-label="BugArcade"><a href="${home}">BugArcade</a><a class="reader-back" href="${home}#challenges">Back to the arcade →</a></nav>`)
    .replace('</main>', '<p class="reader-note">Need the complete technical record? <a href="index.html">Open the original evidence page</a>. All source, trace and test downloads are unchanged.</p></main>');
  if (view === original || !view.includes('reader-nav') || !view.includes('fingerprint')) throw new Error(`Proof presentation was not generated: ${directory}`);
  await writeFile(`${directory}/view.html`, view.replace(/[\t ]+$/gm, ''));
  process.stdout.write(`Prepared ${directory}/view.html; original page preserved\n`);
}
