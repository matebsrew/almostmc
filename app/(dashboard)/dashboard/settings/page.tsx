import { getWorkspace } from "@/lib/workspace";
import { getWorkspaceSecrets } from "@/lib/security/workspace-secrets";
import { SettingsView } from "./settings-view";

export default async function SettingsPage() {
  const { workspace } = await getWorkspace();
  const secrets = await getWorkspaceSecrets(workspace.id);

  return (
    <SettingsView
      workspace={{
        id: workspace.id,
        name: workspace.name,
        hasApiKey: !!secrets.lateApiKey,
        hasAiKey: !!secrets.aiApiKey,
        hasWebhookSecret: !!secrets.lateWebhookSecret,
        globalKeywords: (workspace.global_keywords as string[]) ?? [],
      }}
    />
  );
}
