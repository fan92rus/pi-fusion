import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-fusion extension entry point.
 *
 * MVP scaffold stub — spec 001 task "tool-wiring" replaces this with the real
 * `fusion_delegate` registration (exposure "direct" + immediate deactivation).
 * Exists so the extension loads cleanly and project gates run green from day 0.
 */
export default function fusionExtension(_pi: ExtensionAPI): void {
  // Intentionally empty until spec 001 wiring lands.
}
