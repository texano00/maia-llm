import type { ReactNode } from "react";
import type { SettingsSectionId } from "./sections";

interface SettingsSectionProps {
  id: SettingsSectionId;
  title: string;
  /** One line describing the current state while collapsed. */
  summary: string;
  expanded: boolean;
  onToggle: (id: SettingsSectionId, open: boolean) => void;
  children: ReactNode;
}

/**
 * Native disclosure so keyboard and screen-reader behaviour comes for free.
 * Collapsed by default, one section at a time stays independent.
 */
export function SettingsSection({
  id,
  title,
  summary,
  expanded,
  onToggle,
  children
}: SettingsSectionProps) {
  return (
    <details
      className="settings-section"
      open={expanded}
      onToggle={(event) => onToggle(id, event.currentTarget.open)}
    >
      <summary>
        <span className="settings-section-title">{title}</span>
        <span className="settings-section-summary">{summary}</span>
      </summary>
      <div className="settings-section-body">{children}</div>
    </details>
  );
}
