import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createWorkspaceFromForm, selectWorkspace } from "@/lib/actions/workspace";

export default async function SelectWorkspacePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: memberships } = await supabase
    .from("workspace_members")
    .select("workspace_id, role, workspaces(id, name, slug)")
    .eq("user_id", user.id);

  const workspaces = (memberships ?? [])
    .map((membership) => ({
      workspace: membership.workspaces as { id: string; name: string; slug: string } | null,
      role: membership.role,
    }))
    .filter((membership) => membership.workspace);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-bold">Select a workspace</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Choose the workspace this session should use.
      </p>

      {workspaces.length > 0 ? (
        <div className="mt-6 grid gap-3">
          {workspaces.map(({ workspace, role }) =>
            workspace ? (
              <form key={workspace.id} action={selectWorkspace.bind(null, workspace.id)}>
                <button
                  type="submit"
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-card px-4 py-3 text-left hover:bg-accent"
                >
                  <span className="font-medium">{workspace.name}</span>
                  <span className="text-sm text-muted-foreground">{role}</span>
                </button>
              </form>
            ) : null
          )}
        </div>
      ) : (
        <form action={createWorkspaceFromForm} className="mt-6 grid gap-3">
          <label htmlFor="workspace-name" className="text-sm font-medium">
            Workspace name
          </label>
          <input
            id="workspace-name"
            name="name"
            required
            maxLength={100}
            className="rounded-md border border-border bg-background px-3 py-2"
          />
          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
          >
            Create workspace
          </button>
        </form>
      )}
    </main>
  );
}
