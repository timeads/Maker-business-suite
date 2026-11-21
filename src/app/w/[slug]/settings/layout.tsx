import { NavLink } from "@/components/shell/nav-link";

export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const base = `/w/${slug}/settings`;
  return (
    <>
      <header className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <nav aria-label="Settings" className="bg-muted flex gap-1 rounded-lg p-1 sm:w-fit">
          <NavLink href={base} exact>
            Workspace
          </NavLink>
          <NavLink href={`${base}/team`}>Team</NavLink>
        </nav>
      </header>
      {children}
    </>
  );
}
