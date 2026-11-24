/**
 * The packing slip's own stylesheet, ported from the reference help desk's
 * `SLIP_CSS`. It stands entirely on its own (no Tailwind, no app fonts, every
 * default it relies on spelled out) because the same sheet is shown on
 * screen, printed on paper, and drawn as a picture for a Zebra, where nothing
 * of the app's styling exists. Black and white throughout: thermal printers
 * have no grey.
 */
export const SLIP_CSS = `
.slip-root, .slip-root * { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid #000; }
.slip-root { background: #fff; color: #000; font: 400 11px/1.35 "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif; text-align: left; letter-spacing: normal; -webkit-text-size-adjust: 100%; }
.slip-root img, .slip-root svg { display: block; }
.slip-root b { font-weight: 700; }
.slip-root table { width: 100%; border-collapse: collapse; border-spacing: 0; }
.slip-root th, .slip-root td { text-align: left; font-weight: 400; vertical-align: top; }
.slip-root .slip { display: flex; flex-direction: column; gap: 8px; background: #fff; break-after: page; }
.slip-root .slip.s4x6 { width: 4in; min-height: 6in; padding: 0.3in 0.32in; }
.slip-root .slip.letter { width: 8.5in; min-height: 11in; padding: 0.5in; gap: 14px; }
.slip-root .slip.f-small { font-size: 9.5px; }
.slip-root .slip.f-normal { font-size: 11px; }
.slip-root .slip.f-large { font-size: 12.5px; }
.slip-root .slip.letter.f-small { font-size: 11.5px; }
.slip-root .slip.letter.f-normal { font-size: 13px; }
.slip-root .slip.letter.f-large { font-size: 15px; }
.slip-root .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 8px; border-bottom: 2px solid #000; padding-bottom: 6px; }
.slip-root .head.center { flex-direction: column; align-items: center; text-align: center; }
.slip-root .brandbox { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.slip-root .head.center .brandbox { align-items: center; }
.slip-root .logo { max-width: 100%; width: auto; height: auto; object-fit: contain; }
.slip-root .logo.small { max-height: 0.35in; }
.slip-root .logo.medium { max-height: 0.6in; }
.slip-root .logo.large { max-height: 0.9in; }
.slip-root .letter .logo.small { max-height: 0.5in; }
.slip-root .letter .logo.medium { max-height: 0.8in; }
.slip-root .letter .logo.large { max-height: 1.2in; }
.slip-root .brand { font-size: 1.35em; font-weight: 700; line-height: 1.2; }
.slip-root .right { text-align: right; }
.slip-root .head.center .right { text-align: center; display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 8px; align-items: baseline; margin-top: 6px; }
.slip-root .order { font-size: 1.45em; font-weight: 800; white-space: nowrap; line-height: 1.2; }
.slip-root .boxno { display: inline-block; margin: 2px 0; padding: 1px 8px; border: 2px solid #000; border-radius: 4px; font-weight: 800; font-size: 1.15em; white-space: nowrap; }
.slip-root .v { color: #333; font-size: 0.86em; }
.slip-root .lbl { font-size: 0.78em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #333; }
.slip-root .lbl.more { margin-top: 4px; }
.slip-root .cols { display: grid; grid-template-columns: 1.3fr 1fr; gap: 10px; }
.slip-root .sec { min-width: 0; overflow-wrap: anywhere; }
.slip-root tr { break-inside: avoid; }
.slip-root th { font-size: 0.78em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #333; border-bottom: 1px solid #000; padding: 3px 0; }
.slip-root td { border-bottom: 1px solid #bbb; padding: 4px 4px 4px 0; }
.slip-root td.q, .slip-root th.q { width: 2.6em; }
.slip-root td.q { font-weight: 800; font-size: 1.5em; line-height: 1.15; }
.slip-root td .it { display: block; font-size: 1.3em; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
.slip-root td .it + .v { margin-top: 1px; }
.slip-root td .v { font-size: 0.95em; }
.slip-root td.img { width: 0.5in; }
.slip-root td.img img { width: 0.45in; height: 0.45in; object-fit: cover; filter: grayscale(1) contrast(1.2); }
.slip-root td.p, .slip-root th.p { text-align: right; white-space: nowrap; padding-right: 0; }
.slip-root .note { border: 1px dashed #000; padding: 5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.slip-root .push { flex: 1 1 auto; }
.slip-root .msg { font-weight: 700; text-align: center; font-size: 1.1em; white-space: pre-wrap; }
.slip-root .code { display: flex; flex-direction: column; align-items: center; gap: 2px; text-align: center; }
.slip-root .bars { width: 100%; height: 0.46in; display: flex; justify-content: center; }
.slip-root .bars svg { height: 100%; max-width: 100%; }
.slip-root .foot { text-align: center; font-size: 0.86em; border-top: 1px solid #000; padding-top: 4px; }
`;

/** The page a browser prints slips on: exactly the label, or a letter sheet, with no margin of its own. */
export const slipPageCss = (size: "4x6" | "letter") => `
@media print {
  @page { size: ${size === "letter" ? "8.5in 11in" : "4in 6in"}; margin: 0; }
  html, body { background: #fff !important; }
  .slip-root .slip { break-after: page; box-shadow: none !important; border-radius: 0 !important; }
  .slip-root .slip:last-child { break-after: auto; }
}
`;
