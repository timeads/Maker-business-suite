import { PageHeader } from "@/components/ui/page-header";

/**
 * Workspace Settings: the one place every setting lives. Its list of sections
 * (the workspace's own, then one entry per tool on the plan) is the Settings
 * menu in the panel beside the rail, decided by `settingsNav()` through the
 * navigation model. Each page still checks for itself who may open and change
 * it.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Everything you set up once: your workspace, and each of your tools."
      />
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
    </>
  );
}
