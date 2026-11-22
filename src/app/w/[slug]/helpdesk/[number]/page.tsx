import { notFound, redirect } from "next/navigation";

/** Older links pointed here; a conversation now opens inside the inbox. */
export default async function TicketRedirect({
  params,
}: {
  params: Promise<{ slug: string; number: string }>;
}) {
  const { slug, number } = await params;
  if (!/^\d{1,9}$/.test(number)) notFound();
  redirect(`/w/${slug}/helpdesk?view=all&t=${number}`);
}
