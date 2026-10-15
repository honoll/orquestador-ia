import { ROLES, type AgentId } from "../../lib/office";
import { Panel } from "./QueuePanel";

export interface LogEntry { key: string; time: string; agent: AgentId; text: string; color: string }

export function LogPanel({ entries }: { entries: LogEntry[] }) {
  return (
    <Panel title="LOG">
      {entries.length === 0 ? <p className="text-text-secondary">sin eventos todavía</p> : (
        <ul className="text-text-secondary">
          {entries.map((e) => (
            <li key={e.key} className="truncate">
              {e.time} <b className="font-normal" style={{ color: e.color }}>{ROLES[e.agent].label[0] + ROLES[e.agent].label.slice(1).toLowerCase()}</b> · {e.text}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
