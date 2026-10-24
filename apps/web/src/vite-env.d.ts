/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" starts the app in fixture mode (mainnet snapshot, recorded DAPI answers). */
  readonly VITE_GOVHUB_FIXTURES?: string;
  /** Seeds one bridge into the default endpoint registry. */
  readonly VITE_GOVHUB_BRIDGE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
