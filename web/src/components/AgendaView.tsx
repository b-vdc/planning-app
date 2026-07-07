import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { AgendaDto, ScheduleBlockDto, UserDto } from "@vdv/shared";
import { api } from "../api";

const HOUR_START = 7;
const HOUR_END = 21;
const PX_PER_MIN = 0.9;
const SNAP = 15;

function mondayOf(d: Date): string {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - day);
  return x.toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtMin(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

const yOf = (min: number) => (min - HOUR_START * 60) * PX_PER_MIN;

interface DragState {
  date: string;
  edge: "top" | "bottom" | "move";
  startMinutes: number;
  endMinutes: number;
  grabOffsetMin: number;
}

export function AgendaView({ userId, users }: { userId: string; users: UserDto[] }) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [selectedBlock, setSelectedBlock] = useState<ScheduleBlockDto | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const weekEnd = addDays(weekStart, 6);
  const agendaQuery = useQuery({
    queryKey: ["agenda", userId, weekStart],
    queryFn: () => api<AgendaDto>(`/api/agenda?from=${weekStart}&to=${weekEnd}`),
  });

  const saveWindow = useMutation({
    mutationFn: (w: { date: string; startMinutes: number; endMinutes: number }) =>
      api("/api/work-windows", { method: "PUT", body: JSON.stringify(w) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agenda"] }),
  });

  const markDone = useMutation({
    mutationFn: (itemId: string) => api(`/api/items/${itemId}/done`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agenda"] });
      setSelectedBlock(null);
    },
  });

  const agenda = agendaQuery.data;
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const windowByDate = new Map((agenda?.workWindows ?? []).map((w) => [w.date, w]));
  const today = new Date().toISOString().slice(0, 10);

  const minutesFromEvent = (e: React.MouseEvent, dayEl: Element): number => {
    const rect = dayEl.getBoundingClientRect();
    const raw = (e.clientY - rect.top) / PX_PER_MIN + HOUR_START * 60;
    return Math.round(raw / SNAP) * SNAP;
  };

  const onGridMouseMove = (e: React.MouseEvent) => {
    if (!drag || !gridRef.current) return;
    const dayEl = gridRef.current.querySelector(`[data-date="${drag.date}"]`);
    if (!dayEl) return;
    const min = Math.max(HOUR_START * 60, Math.min(HOUR_END * 60, minutesFromEvent(e, dayEl)));
    setDrag((d) => {
      if (!d) return d;
      if (d.edge === "top") return { ...d, startMinutes: Math.min(min, d.endMinutes - SNAP) };
      if (d.edge === "bottom") return { ...d, endMinutes: Math.max(min, d.startMinutes + SNAP) };
      const len = d.endMinutes - d.startMinutes;
      const start = Math.max(
        HOUR_START * 60,
        Math.min(HOUR_END * 60 - len, min - d.grabOffsetMin),
      );
      return { ...d, startMinutes: start, endMinutes: start + len };
    });
  };

  const onGridMouseUp = () => {
    if (drag) {
      saveWindow.mutate({
        date: drag.date,
        startMinutes: drag.startMinutes,
        endMinutes: drag.endMinutes,
      });
      setDrag(null);
    }
  };

  return (
    <div className="agenda">
      <div className="agenda-toolbar">
        <button onClick={() => setWeekStart(addDays(weekStart, -7))}>‹ Prev</button>
        <strong>
          {weekStart} → {weekEnd}
        </strong>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))}>Next ›</button>
        <button onClick={() => setWeekStart(mondayOf(new Date()))}>Today</button>
        <span className="hint">Drag the shaded area's edges to set your working hours per day.</span>
      </div>

      {agendaQuery.isError && <div className="error">Failed to load the agenda.</div>}

      <div
        className="agenda-grid"
        ref={gridRef}
        onMouseMove={onGridMouseMove}
        onMouseUp={onGridMouseUp}
        onMouseLeave={onGridMouseUp}
      >
        <div className="hour-gutter">
          {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => (
            <div key={i} className="hour-label" style={{ top: i * 60 * PX_PER_MIN }}>
              {String(HOUR_START + i).padStart(2, "0")}:00
            </div>
          ))}
        </div>

        {days.map((date) => {
          const win = drag?.date === date ? drag : windowByDate.get(date);
          const blocks = (agenda?.blocks ?? []).filter((b) => b.date === date);
          return (
            <div key={date} className={`day-col ${date === today ? "today" : ""}`} data-date={date}>
              <div className="day-header">
                {new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}
              </div>
              <div className="day-body" style={{ height: (HOUR_END - HOUR_START) * 60 * PX_PER_MIN }}>
                {win && (
                  <div
                    className="work-window"
                    style={{
                      top: yOf(win.startMinutes),
                      height: (win.endMinutes - win.startMinutes) * PX_PER_MIN,
                    }}
                    onMouseDown={(e) => {
                      const dayEl = e.currentTarget.closest("[data-date]")!;
                      setDrag({
                        date,
                        edge: "move",
                        startMinutes: win.startMinutes,
                        endMinutes: win.endMinutes,
                        grabOffsetMin: minutesFromEvent(e, dayEl) - win.startMinutes,
                      });
                    }}
                  >
                    <div
                      className="window-handle top"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setDrag({
                          date,
                          edge: "top",
                          startMinutes: win.startMinutes,
                          endMinutes: win.endMinutes,
                          grabOffsetMin: 0,
                        });
                      }}
                    />
                    <span className="window-label">
                      {fmtMin(win.startMinutes)}–{fmtMin(win.endMinutes)}
                    </span>
                    <div
                      className="window-handle bottom"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setDrag({
                          date,
                          edge: "bottom",
                          startMinutes: win.startMinutes,
                          endMinutes: win.endMinutes,
                          grabOffsetMin: 0,
                        });
                      }}
                    />
                  </div>
                )}
                {blocks.map((b) => (
                  <div
                    key={b.id}
                    className={`block ${b.kind} ${selectedBlock?.id === b.id ? "selected" : ""}`}
                    style={{
                      top: yOf(b.startMinutes),
                      height: Math.max(18, (b.endMinutes - b.startMinutes) * PX_PER_MIN),
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => setSelectedBlock(selectedBlock?.id === b.id ? null : b)}
                    title={`${b.label} (${fmtMin(b.startMinutes)}–${fmtMin(b.endMinutes)})`}
                  >
                    <span className="block-time">{fmtMin(b.startMinutes)}</span> {b.label}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {selectedBlock && agenda && (
        <div className="block-detail">
          <h3>
            {selectedBlock.label} — {selectedBlock.date} {fmtMin(selectedBlock.startMinutes)}–
            {fmtMin(selectedBlock.endMinutes)}
          </h3>
          <ul>
            {selectedBlock.itemIds.map((id) => {
              const item = agenda.items[id];
              if (!item) return null;
              return (
                <li key={id}>
                  <span>
                    <strong>{item.title}</strong>
                    {item.estimatedMinutes ? ` · ${item.estimatedMinutes} min` : ""}
                    {item.dueAt ? ` · due ${new Date(item.dueAt).toLocaleString()}` : ""}
                    {item.guests.length > 0 &&
                      ` · with ${item.guests
                        .map((g) => users.find((u) => u.id === g)?.name ?? "?")
                        .join(", ")}`}
                  </span>
                  {item.status === "open" && (
                    <button onClick={() => markDone.mutate(id)} disabled={markDone.isPending}>
                      ✓ Done
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <button onClick={() => setSelectedBlock(null)}>Close</button>
        </div>
      )}
    </div>
  );
}
