<script setup lang="ts">
import { connectionAdvice } from '@rka/shared';
import { computed } from 'vue';
import { useSettings } from '../../composables/useSettings';
import SettingsForm from './SettingsForm.vue';

/** Security settings plus a read-only overview of the protections in place. */
const { view } = useSettings();

const advice = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return connectionAdvice(url);
  } catch {
    return null;
  }
};
const LOCATION = {
  loopback: 'this computer',
  private: 'your network',
  public: 'the internet',
} as const;
const servers = computed(() => {
  const v = view.value?.values;
  if (!v) return [];
  return [
    { name: 'Ollama', url: v['ollama.baseUrl'], advice: advice(v['ollama.baseUrl']) },
    { name: 'SearXNG', url: v['searxng.url'], advice: advice(v['searxng.url']) },
  ];
});
</script>

<template>
  <div class="panel" data-testid="security-panel">
    <SettingsForm
      :keys="['security.requireHttpsForRemote']"
      title="Remote connections"
      testid="security-form"
    />

    <section class="card info">
      <h3>Current connections</h3>
      <table>
        <tbody>
          <tr v-for="s in servers" :key="s.name" :data-testid="`security-${s.name.toLowerCase()}`">
            <th>{{ s.name }}</th>
            <td>{{ s.url ?? 'Not configured' }}</td>
            <td v-if="s.advice">
              <span class="pill" :data-tone="s.advice.warnings.length ? 'warn' : 'ok'">
                {{ s.advice.encrypted ? 'HTTPS' : 'HTTP' }} · {{ LOCATION[s.advice.location] }}
              </span>
              <p v-for="w in s.advice.warnings" :key="w" class="warn">{{ w }}</p>
            </td>
            <td v-else></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="card info">
      <h3>Secrets</h3>
      <p>
        OS encryption (Windows DPAPI via Electron safeStorage):
        <strong data-testid="encryption-status">{{
          view?.encryptionAvailable ? 'Available' : 'Not available'
        }}</strong>
      </p>
      <p>
        Ollama access token:
        <strong>{{
          view?.secrets['ollama.authToken']?.set ? 'Set (encrypted)' : 'Not set'
        }}</strong>
        — change it under Ollama Connection.
      </p>
      <p class="muted small">
        Secrets are stored encrypted in the local database, used only by the main process, and never
        sent to this window, written to logs or included in error messages.
      </p>
    </section>

    <section class="card info">
      <h3>Protections that are always on</h3>
      <ul class="small">
        <li>
          Ollama and SearXNG URLs are validated (http/https only, no credentials, query or
          fragment).
        </li>
        <li>
          Redirects from the Ollama server are refused; the access token is only sent over HTTPS or
          to this computer.
        </li>
        <li>
          Web pages are fetched only from public addresses (no localhost, private networks or cloud
          metadata), also after redirects.
        </li>
        <li>
          Web content is treated as untrusted data in every prompt; the model cannot run tools or
          commands.
        </li>
        <li>
          No shell commands, no file deletion, no model downloads; backups always ask where to save.
        </li>
        <li>This window has no Node.js access; every request is validated in the main process.</li>
      </ul>
      <p class="muted small">
        Remote Ollama: prefer a VPN (e.g. WireGuard or Tailscale) or an HTTPS reverse proxy with an
        access token. Never expose an unauthenticated Ollama port to the internet.
      </p>
    </section>
  </div>
</template>

<style scoped>
.panel {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.panel > * {
  min-width: 0;
}
.info {
  padding: 14px 16px;
}
h3 {
  margin: 0 0 8px;
  font-size: 1rem;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  text-align: left;
  vertical-align: top;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
td {
  overflow-wrap: anywhere;
}
.pill {
  font-size: 0.8rem;
  padding: 1px 10px;
  border-radius: 999px;
  color: var(--tone-fg);
  background: var(--tone-bg);
}
.warn {
  margin: 4px 0 0;
  color: var(--warn);
  font-size: 0.85rem;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 0.88rem;
}
</style>
