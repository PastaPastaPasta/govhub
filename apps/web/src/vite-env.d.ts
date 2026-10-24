/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" starts the app in fixture mode (mainnet snapshot, recorded DAPI answers). */
  readonly VITE_GOVHUB_FIXTURES?: string;
  /** Replaces the default bridge (https://gov-bridge.dashhq.org) in the default endpoint registry; empty or "none" = no bridge. */
  readonly VITE_GOVHUB_BRIDGE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
