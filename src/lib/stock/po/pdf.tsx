import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { PoDocument } from "./document";

/**
 * The purchase order as a PDF, laid out as TuftStock's is (ported from its
 * src/lib/po/PoPdf.tsx): logo, business and address top left; "Purchase
 * Order", number and status top right; supplier and dates; the lines; totals.
 * Drawn on the server only, with the PDF's own built-in Helvetica, so nothing
 * is fetched to make it.
 */

const s = StyleSheet.create({
  page: { padding: 36, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  row: { flexDirection: "row" },
  between: { flexDirection: "row", justifyContent: "space-between" },
  h1: { fontSize: 16, fontFamily: "Helvetica-Bold" },
  muted: { color: "#666" },
  section: { marginTop: 14 },
  label: { fontFamily: "Helvetica-Bold", marginBottom: 2 },
  th: {
    fontFamily: "Helvetica-Bold",
    borderBottom: 1,
    borderColor: "#999",
    paddingBottom: 3,
    paddingTop: 3,
  },
  td: { borderBottom: 0.5, borderColor: "#ddd", paddingVertical: 3 },
  cSku: { width: "15%", paddingRight: 4 },
  cSupSku: { width: "15%", paddingRight: 4 },
  cTitle: { width: "32%", paddingRight: 4 },
  cMoq: { width: "8%", textAlign: "right" },
  cQty: { width: "8%", textAlign: "right" },
  cCost: { width: "10%", textAlign: "right" },
  cTotal: { width: "12%", textAlign: "right" },
  totals: { marginTop: 10, marginLeft: "auto", width: "45%" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1 },
  grand: {
    fontFamily: "Helvetica-Bold",
    borderTop: 1,
    borderColor: "#999",
    marginTop: 3,
    paddingTop: 3,
  },
});

/** A logo the server already holds, as bytes. Only PNG and JPEG can be drawn. */
export type PoLogo = { data: Buffer; format: "png" | "jpg" };

export async function renderPoPdf(doc: PoDocument, logo: PoLogo | null = null): Promise<Buffer> {
  return renderToBuffer(
    <Document title={doc.title} author={doc.business.name}>
      <Page size="A4" style={s.page}>
        <View style={s.between}>
          <View style={{ maxWidth: "60%" }}>
            {logo ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, not an HTML one
              <Image
                src={logo}
                style={{
                  width: 120,
                  height: 48,
                  objectFit: "contain",
                  objectPositionX: 0,
                  marginBottom: 6,
                }}
              />
            ) : null}
            <Text style={s.h1}>{doc.business.name}</Text>
            {doc.business.addressLines.map((line, index) => (
              <Text key={index} style={s.muted}>
                {line}
              </Text>
            ))}
          </View>
          <View style={{ textAlign: "right" }}>
            <Text style={s.h1}>Purchase Order</Text>
            <Text style={s.muted}>{doc.number}</Text>
            <Text style={s.muted}>Status: {doc.status}</Text>
          </View>
        </View>

        <View style={[s.section, s.between]}>
          <View style={{ maxWidth: "60%" }}>
            <Text style={s.label}>Supplier</Text>
            <Text>{doc.supplier.name}</Text>
            {doc.supplier.contact ? <Text style={s.muted}>{doc.supplier.contact}</Text> : null}
            {doc.supplier.emails ? <Text style={s.muted}>{doc.supplier.emails}</Text> : null}
          </View>
          <View style={{ textAlign: "right" }}>
            <Text style={s.label}>Dates</Text>
            <Text style={s.muted}>Created {doc.dates.created}</Text>
            <Text style={s.muted}>Sent {doc.dates.sent}</Text>
            <Text style={s.muted}>Expected {doc.dates.expected}</Text>
          </View>
        </View>

        <View style={s.section}>
          <View style={[s.row, s.th]} fixed>
            <Text style={s.cSku}>SKU</Text>
            <Text style={s.cSupSku}>Supplier SKU</Text>
            <Text style={s.cTitle}>Item</Text>
            <Text style={s.cMoq}>MOQ</Text>
            <Text style={s.cQty}>Qty</Text>
            <Text style={s.cCost}>Unit</Text>
            <Text style={s.cTotal}>Total</Text>
          </View>
          {doc.lines.map((line, index) => (
            <View key={index} style={[s.row, s.td]} wrap={false}>
              <Text style={s.cSku}>{line.sku}</Text>
              <Text style={s.cSupSku}>{line.supplierSku}</Text>
              <Text style={s.cTitle}>{line.item}</Text>
              <Text style={s.cMoq}>{line.moq}</Text>
              <Text style={s.cQty}>{line.qty}</Text>
              <Text style={s.cCost}>{line.unit}</Text>
              <Text style={s.cTotal}>{line.total}</Text>
            </View>
          ))}
        </View>

        <View style={s.totals} wrap={false}>
          {doc.totals.map((row) => (
            <View key={row.label} style={row.strong ? [s.totalRow, s.grand] : s.totalRow}>
              <Text>{row.label}</Text>
              <Text>{row.value}</Text>
            </View>
          ))}
        </View>

        {doc.notes ? (
          <View style={s.section}>
            <Text style={s.label}>Notes</Text>
            <Text style={s.muted}>{doc.notes}</Text>
          </View>
        ) : null}
      </Page>
    </Document>,
  );
}
