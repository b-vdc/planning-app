import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SettingsDto } from "@vdv/shared";
import { api } from "../api";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsDto>("/api/settings"),
  });

  const [horizon, setHorizon] = useState(14);
  const [cron, setCron] = useState("0 * * * *");
  const [timezone, setTimezone] = useState("Europe/Brussels");

  useEffect(() => {
    if (settingsQuery.data) {
      setHorizon(settingsQuery.data.planningHorizonDays);
      setCron(settingsQuery.data.recalcCron);
      setTimezone(settingsQuery.data.timezone);
    }
  }, [settingsQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      api<SettingsDto>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ planningHorizonDays: horizon, recalcCron: cron, timezone }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      onClose();
    },
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label>
          Planning horizon (days ahead the AI plans)
          <input
            type="number"
            min={1}
            max={90}
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
          />
        </label>
        <label>
          Recalculation cadence (cron expression)
          <input value={cron} onChange={(e) => setCron(e.target.value)} />
          <small>e.g. "0 * * * *" = hourly, "*/30 8-18 * * 1-5" = every 30 min on workdays</small>
        </label>
        <label>
          Firm timezone
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
