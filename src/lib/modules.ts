/** `available` flips to true when a module's screens ship. */
export const MODULES = [
  {
    key: "dashboard",
    name: "Money",
    blurb: "Sales, margins and cash in one view",
    available: true,
  },
  {
    key: "helpdesk",
    name: "Help desk",
    blurb: "One inbox with order details alongside",
    available: false,
  },
  {
    key: "bookings",
    name: "Bookings",
    blurb: "Workshops and appointments, paid up front",
    available: false,
  },
  { key: "social", name: "Social", blurb: "Plan and schedule your posts", available: false },
] as const;

export type ModuleKey = (typeof MODULES)[number]["key"];
