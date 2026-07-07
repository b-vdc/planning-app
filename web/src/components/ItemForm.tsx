import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { CoreField, ItemDto, ItemTypeDef, UserDto } from "@vdv/shared";
import { api } from "../api";

const CORE_FIELD_LABELS: Record<CoreField, string> = {
  dueAt: "Due date",
  startAt: "Start date",
  endAt: "End date",
  notBeforeAt: "Do not start before",
  estimatedMinutes: "Estimated time (minutes)",
  guests: "Guests",
};

const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

export function ItemForm({ users, onClose }: { users: UserDto[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const typesQuery = useQuery({
    queryKey: ["item-types"],
    queryFn: () => api<ItemTypeDef[]>("/api/item-types"),
  });
  const types = typesQuery.data ?? [];

  const [type, setType] = useState("todo");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [guests, setGuests] = useState<string[]>([]);
  const [activeOptional, setActiveOptional] = useState<string[]>([]);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [dependsOn, setDependsOn] = useState<ItemDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const typeDef = types.find((t) => t.type === type);

  const depResults = useQuery({
    queryKey: ["item-search", depSearch],
    queryFn: () => api<ItemDto[]>(`/api/items?query=${encodeURIComponent(depSearch)}&limit=8`),
    enabled: depSearch.length >= 2,
  });

  // Fields shown = the type's native fields + optional fields the user added via "+".
  const shownFields = useMemo(() => {
    if (!typeDef) return [];
    return [...typeDef.nativeFields, ...activeOptional.filter((f) => !typeDef.nativeFields.includes(f as CoreField))];
  }, [typeDef, activeOptional]);

  const plusOptions = useMemo(() => {
    if (!typeDef) return [];
    const core = typeDef.optionalCoreFields
      .filter((f) => !shownFields.includes(f))
      .map((f) => ({ key: f, label: CORE_FIELD_LABELS[f] }));
    const extra = typeDef.optionalExtraFields
      .filter((f) => !shownFields.includes(f.key))
      .map((f) => ({ key: f.key, label: f.label }));
    return [...core, ...extra];
  }, [typeDef, shownFields]);

  const save = useMutation({
    mutationFn: () => {
      const extraDefs = new Map(typeDef?.optionalExtraFields.map((f) => [f.key, f]) ?? []);
      const extra: Record<string, unknown> = {};
      for (const key of shownFields) {
        if (extraDefs.has(key) && values[key]) extra[key] = values[key];
      }
      return api<ItemDto>("/api/items", {
        method: "POST",
        body: JSON.stringify({
          type,
          title,
          description,
          dueAt: shownFields.includes("dueAt") ? toIso(values.dueAt ?? "") : null,
          startAt: shownFields.includes("startAt") ? toIso(values.startAt ?? "") : null,
          endAt: shownFields.includes("endAt") ? toIso(values.endAt ?? "") : null,
          notBeforeAt: shownFields.includes("notBeforeAt") ? toIso(values.notBeforeAt ?? "") : null,
          estimatedMinutes:
            shownFields.includes("estimatedMinutes") && values.estimatedMinutes
              ? Number(values.estimatedMinutes)
              : null,
          extra,
          guests,
          dependsOn: dependsOn.map((d) => d.id),
        }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agenda"] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const setValue = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));

  const renderField = (key: string) => {
    const extraDef = typeDef?.optionalExtraFields.find((f) => f.key === key);
    if (key === "guests") {
      return (
        <label key={key}>
          Guests
          <div className="guest-choices">
            {users.map((u) => (
              <label key={u.id} className="guest-choice">
                <input
                  type="checkbox"
                  checked={guests.includes(u.id)}
                  onChange={(e) =>
                    setGuests((g) => (e.target.checked ? [...g, u.id] : g.filter((x) => x !== u.id)))
                  }
                />
                {u.name}
              </label>
            ))}
          </div>
        </label>
      );
    }
    if (key === "estimatedMinutes") {
      return (
        <label key={key}>
          {CORE_FIELD_LABELS.estimatedMinutes}
          <input
            type="number"
            min={5}
            step={5}
            value={values[key] ?? ""}
            onChange={(e) => setValue(key, e.target.value)}
          />
        </label>
      );
    }
    if (extraDef) {
      return (
        <label key={key}>
          {extraDef.label}
          <input
            type={extraDef.input === "text" ? "text" : "datetime-local"}
            value={values[key] ?? ""}
            onChange={(e) => setValue(key, e.target.value)}
          />
        </label>
      );
    }
    return (
      <label key={key}>
        {CORE_FIELD_LABELS[key as CoreField] ?? key}
        <input
          type="datetime-local"
          value={values[key] ?? ""}
          onChange={(e) => setValue(key, e.target.value)}
        />
      </label>
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New item</h2>

        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </label>
        <label>
          Type
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setActiveOptional([]);
            }}
          >
            {types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {shownFields.map(renderField)}

        {plusOptions.length > 0 && (
          <div className="plus-field">
            <button type="button" onClick={() => setShowPlusMenu((s) => !s)}>
              + Add field
            </button>
            {showPlusMenu && (
              <div className="plus-menu">
                {plusOptions.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => {
                      setActiveOptional((s) => [...s, o.key]);
                      setShowPlusMenu(false);
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="dep-picker">
          <label>
            Depends on
            <input
              placeholder="Search items by title…"
              value={depSearch}
              onChange={(e) => setDepSearch(e.target.value)}
            />
          </label>
          {depSearch.length >= 2 && (
            <div className="dep-results">
              {(depResults.data ?? [])
                .filter((r) => !dependsOn.some((d) => d.id === r.id))
                .map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setDependsOn((d) => [...d, r]);
                      setDepSearch("");
                    }}
                  >
                    {r.title} <em>({r.type})</em>
                  </button>
                ))}
            </div>
          )}
          {dependsOn.length > 0 && (
            <div className="dep-chips">
              {dependsOn.map((d) => (
                <span key={d.id} className="chip">
                  after: {d.title}
                  <button type="button" onClick={() => setDependsOn((x) => x.filter((y) => y.id !== d.id))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!title || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
