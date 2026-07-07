import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { UserDto } from "@vdv/shared";
import { api, getCurrentUserId, setCurrentUserId } from "./api";
import { AgendaView } from "./components/AgendaView";
import { ItemForm } from "./components/ItemForm";
import { SettingsPanel } from "./components/SettingsPanel";

export default function App() {
  const [userId, setUserId] = useState<string | null>(getCurrentUserId());
  const [showItemForm, setShowItemForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const queryClient = useQueryClient();

  const usersQuery = useQuery({ queryKey: ["users"], queryFn: () => api<UserDto[]>("/api/users") });

  const recalc = useMutation({
    mutationFn: () => api("/api/agenda/recalculate", { method: "POST", body: "{}" }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["agenda"] });
      const warnings = (result as { warnings?: string[] })?.warnings ?? [];
      if (warnings.length) alert(warnings.join("\n"));
    },
  });

  const pickUser = (id: string) => {
    setCurrentUserId(id);
    setUserId(id);
    void queryClient.invalidateQueries();
  };

  if (usersQuery.isLoading) return <div className="centered">Loading…</div>;
  if (usersQuery.isError) return <div className="centered">Cannot reach the server.</div>;
  const users = usersQuery.data ?? [];
  const me = users.find((u) => u.id === userId) ?? null;

  if (!me) {
    return (
      <div className="centered">
        <div className="user-gate">
          <h1>Van der Volpi</h1>
          <p>Who are you?</p>
          <div className="user-gate-buttons">
            {users.map((u) => (
              <button key={u.id} style={{ borderColor: u.color }} onClick={() => pickUser(u.id)}>
                {u.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>Van der Volpi</h1>
        <div className="header-actions">
          <button className="primary" onClick={() => setShowItemForm(true)}>
            + New item
          </button>
          <button onClick={() => recalc.mutate()} disabled={recalc.isPending}>
            {recalc.isPending ? "Planning…" : "⟳ Recalculate"}
          </button>
          <button onClick={() => setShowSettings(true)}>Settings</button>
          <select value={me.id} onChange={(e) => pickUser(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <AgendaView userId={me.id} users={users} />

      {showItemForm && <ItemForm users={users} onClose={() => setShowItemForm(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
