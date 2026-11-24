import { describe, expect, it } from "vitest";
import { reprintQuestion } from "./reprint";

const slip = (...orderIds: string[]) => ({ orderIds });
const printed = (id: string) => ({ id, name: `#${id}`, when: "Nov 24, 2:10 PM" });

describe("asking before slips are printed again", () => {
  it("asks nothing when none was printed before", () => {
    expect(reprintQuestion([slip("1"), slip("2")], [])).toBeNull();
    // Printed orders that aren't in this run don't count.
    expect(reprintQuestion([slip("1")], [printed("9")])).toBeNull();
  });

  it("offers only the new ones when some were printed", () => {
    const slips = [slip("1"), slip("2"), slip("3")];
    const question = reprintQuestion(slips, [printed("2")]);
    expect(question?.title).toBe("1 of 3 orders' packing slips were already printed");
    expect(question?.freshOrders).toBe(2);
    expect(question?.fresh).toEqual([slips[0], slips[2]]);
    expect(question?.lines).toEqual(["#2: printed Nov 24, 2:10 PM"]);
  });

  it("offers only printing again when all were printed", () => {
    expect(reprintQuestion([slip("1")], [printed("1")])).toMatchObject({
      title: "This order's packing slip was already printed",
      freshOrders: 0,
      fresh: [],
    });
    expect(reprintQuestion([slip("1"), slip("2")], [printed("1"), printed("2")])?.title).toBe(
      "All 2 orders' packing slips were already printed",
    );
  });

  it("counts an order split over several boxes once", () => {
    const question = reprintQuestion([slip("1"), slip("1"), slip("2")], [printed("1")]);
    expect(question?.title).toBe("1 of 2 orders' packing slips were already printed");
    expect(question?.freshOrders).toBe(1);
    expect(reprintQuestion([slip("1"), slip("1")], [printed("1")])?.title).toBe(
      "This order's packing slips were already printed",
    );
  });

  it("treats a slip for orders going together as printed when any of them was", () => {
    const together = slip("1", "2");
    const question = reprintQuestion([together], [printed("2")]);
    expect(question?.freshOrders).toBe(0);
    expect(question?.fresh).toEqual([]);
  });

  it("lists eight at most, then says how many more", () => {
    const ids = Array.from({ length: 11 }, (_, index) => String(index + 1));
    const question = reprintQuestion(
      ids.map((id) => slip(id)),
      ids.map(printed),
    );
    expect(question?.lines).toHaveLength(9);
    expect(question?.lines.at(-1)).toBe("…and 3 more");
  });
});
