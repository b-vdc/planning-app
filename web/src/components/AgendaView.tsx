import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { AgendaDto, ScheduleBlockDto, UserDto } from "@vdv/shared";
import { api } from "../api";

const HOUR_START = 7;
const HOUR_END = 21;
const PX_PER_MIN = 0.9;
const SNAP = 15;

function mondayOf(date: string): string {
  const x = new Date(`${date}T00:00:00`);
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

function fmtDate(date: string, opts: Intl.DateTimeFormatOptions): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, opts);
}

const yOf = (min: number) => (min - HOUR_START * 60) * PX_PER_MIN;

// 1 day on phones, 3 on tablets, a full week on desktop.
function visibleDayCount(): number {
  if (window.matchMedia("(max-width: 640px)").matches) return 1;
  if (window.matchMedia("(max-width: 1000px)").matches) return 3;
  return 7;
}

function useVisibleDays(): number {
  const [count, setCount] = useState(visibleDayCount);
  useEffect(() => {
    const onResize = () => setCount(visibleDayCount());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return count;
}

interface DragState {
  date: string;
  edge: "top" | "bottom" | "move";
  startMinutes: number;
  endMinutes: number;
  grabOffsetMin: number;
}

export function AgendaView({ userId, users }: { userId: string; users: UserDto[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const visibleDays = useVisibleDays();
  const [anchor, setAnchor] = useState(today);
  const [selectedBlock, setSelectedBlock] = useState<ScheduleBlockDto | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const rangeStart = visibleDays === 7 ? mondayOf(anchor) : anchor;
  const rangeEnd = addDays(rangeStart, visibleDays - 1);
  const agendaQuery = useQuery({
    queryKey: ["agenda", userId, rangeStart, visibleDays],
    queryFn: () => api<AgendaDto>(`/api/agenda?from=${rangeStart}&to=${rangeEnd}`),
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
  const days = Array.from({ length: visibleDays }, (_, i) => addDays(rangeStart, i));
  const windowByDate = new Map((agenda?.workWindows ?? []).map((w) => [w.date, w]));

  const rangeLabel =
    visibleDays === 1
      ? fmtDate(rangeStart, { weekday: "short", day: "numeric", month: "short" })
      : `${fmtDate(rangeStart, { day: "numeric", month: "short" })} – ${fmtDate(rangeEnd, {
          day: "numeric",
          month: "short",
        })}`;

  const minutesFromEvent = (e: React.PointerEvent, dayEl: Element): number => {
    const rect = dayEl.getBoundingClientRect();
    const raw = (e.clientY - rect.top) / PX_PER_MIN + HOUR_START * 60;
    return Math.round(raw / SNAP) * SNAP;
  };

  const onGridPointerMove = (e: React.PointerEvent) => {
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

  const onGridPointerUp = () => {
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
        <button aria-label="Previous" onClick={() => setAnchor(addDays(rangeStart, -visibleDays))}>
          ‹ Prev
        </button>
        <strong className="range-label">{rangeLabel}</strong>
        <button aria-label="Next" onClick={() => setAnchor(addDays(rangeStart, visibleDays))}>
          Next ›
        </button>
        <button onClick={() => setAnchor(today)}>Today</button>
        <span className="hint">Drag the shaded area's edges to set your working hours per day.</span>
      </div>

      {agendaQuery.isError && <div className="error">Failed to load the agenda.</div>}

      <div
        className="agenda-grid"
        style={{ "--day-count": visibleDays } as React.CSSProperties}
        ref={gridRef}
        onPointerMove={onGridPointerMove}
        onPointerUp={onGridPointerUp}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={onGridPointerUp}
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
                {fmtDate(date, { weekday: "short", day: "numeric", month: "short" })}
              </div>
              <div className="day-body" style={{ height: (HOUR_END - HOUR_START) * 60 * PX_PER_MIN }}>
                {win && (
                  <div
                    className="work-window"
                    style={{
                      top: yOf(win.startMinutes),
                      height: (win.endMinutes - win.startMinutes) * PX_PER_MIN,
                    }}
                    onPointerDown={(e) => {
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
                      onPointerDown={(e) => {
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
                      onPointerDown={(e) => {
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
                    onPointerDown={(e) => e.stopPropagation()}
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
