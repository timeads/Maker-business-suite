export const MODULES = [
  { key: "dashboard", name: "Money", blurb: "Sales, margins and cash in one view" },
  { key: "helpdesk", name: "Help desk", blurb: "One inbox with order details alongside" },
  { key: "bookings", name: "Bookings", blurb: "Workshops and appointments, paid up front" },
  { key: "social", name: "Social", blurb: "Plan and schedule your posts" },
] as const;

export type ModuleKey = (typeof MODULES)[number]["key"];
