import { existsSync } from "node:fs";
import { join } from "node:path";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { RunsheetDoc } from "./runsheet";

/**
 * The runsheet (and a date's roster) as a PDF for the studio floor: one block
 * per class, a box to tick for each person, "Returning" beside anyone who has
 * come before. Drawn on the server only with the PDF's built-in Helvetica, and
 * Stock's bundled Noto Sans SC only for names Helvetica can't draw, so nothing
 * is fetched to make it. The words all come from `buildRunsheet`.
 */

const FALLBACK = "Noto Sans SC";
const FALLBACK_FILE = join(
  process.cwd(),
  "src",
  "lib",
  "stock",
  "po",
  "fonts",
  "NotoSansSC-Regular.woff",
);
let fallbackReady: boolean | null = null;
function fallbackFont(): boolean {
  if (fallbackReady === null) {
    fallbackReady = existsSync(FALLBACK_FILE);
    if (fallbackReady) Font.register({ family: FALLBACK, src: FALLBACK_FILE });
  }
  return fallbackReady;
}
const regular = () => (fallbackFont() ? ["Helvetica", FALLBACK] : "Helvetica");
const bold = () => (fallbackFont() ? ["Helvetica-Bold", FALLBACK] : "Helvetica-Bold");

const styles = () =>
  StyleSheet.create({
    page: { padding: 36, fontSize: 9.5, fontFamily: regular(), color: "#111" },
    h1: { fontSize: 16, fontFamily: bold() },
    muted: { color: "#666" },
    block: { marginTop: 16 },
    h2: { fontSize: 12, fontFamily: bold() },
    row: { flexDirection: "row", alignItems: "flex-start" },
    th: { fontFamily: bold(), borderBottom: 1, borderColor: "#999", paddingVertical: 3 },
    td: { borderBottom: 0.5, borderColor: "#ddd", paddingVertical: 4 },
    cBox: { width: 22 },
    box: { width: 11, height: 11, border: 1, borderColor: "#444", marginTop: 0.5 },
    cName: { width: "34%", paddingRight: 6 },
    cContact: { flexGrow: 1, flexBasis: 0, paddingRight: 6 },
    cSeats: { width: 40, textAlign: "right" },
    badge: { fontFamily: bold(), fontSize: 7.5, color: "#1f6f5c" },
    extra: { color: "#444", fontSize: 8.5, marginTop: 1 },
  });

export async function renderRunsheetPdf(doc: RunsheetDoc): Promise<Buffer> {
  const s = styles();
  return renderToBuffer(
    <Document title={`${doc.title}, ${doc.subtitle}`} author={doc.business}>
      <Page size="LETTER" style={s.page}>
        <View>
          <Text style={s.h1}>{doc.title}</Text>
          <Text style={s.muted}>
            {doc.business} · {doc.subtitle}
          </Text>
          {doc.footnote ? <Text style={s.muted}>{doc.footnote}</Text> : null}
        </View>
        {doc.blocks.length === 0 ? <Text style={[s.block, s.muted]}>{doc.empty}</Text> : null}
        {doc.blocks.map((block) => (
          <View key={block.id} style={s.block}>
            <View wrap={false}>
              <Text style={s.h2}>{block.title}</Text>
              <Text style={s.muted}>
                {block.when}
                {block.line ? ` · ${block.line}` : ""}
              </Text>
              <View style={[s.row, s.th, { marginTop: 6 }]}>
                <Text style={s.cBox}>In</Text>
                <Text style={s.cName}>Name</Text>
                <Text style={s.cContact}>Contact</Text>
                <Text style={s.cSeats}>Places</Text>
              </View>
            </View>
            {block.rows.length === 0 ? <Text style={[s.td, s.muted]}>{doc.empty}</Text> : null}
            {block.rows.map((row, index) => (
              <View key={index} style={[s.row, s.td]} wrap={false}>
                <View style={s.cBox}>
                  <View style={[s.box, row.here ? { backgroundColor: "#444" } : {}]} />
                </View>
                <View style={s.cName}>
                  <Text>{row.name}</Text>
                  {row.returning ? <Text style={s.badge}>RETURNING</Text> : null}
                </View>
                <View style={s.cContact}>
                  <Text>{row.contact}</Text>
                  {row.extra.map((line, i) => (
                    <Text key={i} style={s.extra}>
                      {line}
                    </Text>
                  ))}
                </View>
                <Text style={s.cSeats}>{row.seats}</Text>
              </View>
            ))}
          </View>
        ))}
      </Page>
    </Document>,
  );
}
