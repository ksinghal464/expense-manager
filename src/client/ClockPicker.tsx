import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import {
  angleFromCenter,
  displayTime,
  formatTime,
  hourAngle,
  hourFromAngle,
  joinDateTime,
  minuteAngle,
  minuteFromAngle,
  parseTime,
  splitDateTime,
  to12h,
  to24h,
} from './clock';
import type { Meridiem } from './clock';

const SIZE = 240;
const C = SIZE / 2;
const R_LABEL = 92;
const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTE_MARKS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

const pointAt = (angle: number, r: number) => {
  const rad = (angle * Math.PI) / 180;
  return { x: C + r * Math.sin(rad), y: C - r * Math.cos(rad) };
};

/**
 * Clock-dial time picker shown as a bottom sheet (Material-style): pick the
 * hour on the dial, it then switches to minutes. Tapping a minute snaps to
 * the nearest 5; dragging gives any minute. Works with touch and mouse.
 */
export function ClockPicker({
  value,
  onCancel,
  onConfirm,
}: {
  /** "HH:mm" (24h). */
  value: string;
  onCancel: () => void;
  onConfirm: (time: string) => void;
}) {
  const initial = parseTime(value);
  const init12 = to12h(initial.hour);
  const [hour12, setHour12] = useState(init12.hour12);
  const [meridiem, setMeridiem] = useState<Meridiem>(init12.meridiem);
  const [minute, setMinute] = useState(initial.minute);
  const [mode, setMode] = useState<'hour' | 'minute'>('hour');
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const angleOf = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return angleFromCenter(
      e.clientX - (rect.left + rect.width / 2),
      e.clientY - (rect.top + rect.height / 2)
    );
  };
  const apply = (e: React.PointerEvent) => {
    const a = angleOf(e);
    if (mode === 'hour') setHour12(hourFromAngle(a));
    else setMinute(minuteFromAngle(a));
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, moved: false };
    apply(e);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6) d.moved = true;
    apply(e);
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (mode === 'hour') {
      setMode('minute');
    } else if (!d.moved) {
      // A plain tap snaps to the nearest 5-minute mark; drag for exact minutes.
      setMinute(minuteFromAngle(angleOf(e), 5));
    }
  };

  const handAngle = mode === 'hour' ? hourAngle(hour12) : minuteAngle(minute);
  const tip = pointAt(handAngle, R_LABEL);
  const marks = mode === 'hour' ? HOURS : MINUTE_MARKS;
  const isSelected = (n: number) => (mode === 'hour' ? n === hour12 : n === minute);

  return createPortal(
    <div
      className="clockoverlay"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="clocksheet" role="dialog" aria-label="Select time">
        <div className="clockhead">
          <button
            type="button"
            className={mode === 'hour' ? 'active' : ''}
            onClick={() => setMode('hour')}
            aria-label="Edit hour"
          >
            {String(hour12).padStart(2, '0')}
          </button>
          <span>:</span>
          <button
            type="button"
            className={mode === 'minute' ? 'active' : ''}
            onClick={() => setMode('minute')}
            aria-label="Edit minutes"
          >
            {String(minute).padStart(2, '0')}
          </button>
          <div className="clockampm">
            {(['AM', 'PM'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={meridiem === m ? 'active' : ''}
                onClick={() => setMeridiem(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <svg
          ref={svgRef}
          className="clockdial"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
        >
          <circle cx={C} cy={C} r={C - 4} className="clockface" />
          <line x1={C} y1={C} x2={tip.x} y2={tip.y} className="clockhand" />
          <circle cx={C} cy={C} r={4} className="clockpivot" />
          <circle cx={tip.x} cy={tip.y} r={18} className="clockknob" />
          {marks.map((n) => {
            const p = pointAt(mode === 'hour' ? hourAngle(n) : minuteAngle(n), R_LABEL);
            return (
              <text
                key={n}
                x={p.x}
                y={p.y}
                className={'clocknum' + (isSelected(n) ? ' selected' : '')}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {mode === 'hour' ? n : String(n).padStart(2, '0')}
              </text>
            );
          })}
          {mode === 'minute' && minute % 5 !== 0 && (
            <circle cx={tip.x} cy={tip.y} r={3} className="clockdot" />
          )}
        </svg>

        <div className="clockactions">
          <button type="button" className="outline" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="clockok"
            onClick={() => onConfirm(formatTime(to24h(hour12, meridiem), minute))}
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * Date + time field for a datetime-local style value ("YYYY-MM-DDTHH:mm"):
 * the browser's date-only input (a calendar on Android) plus a time button
 * that opens the ClockPicker dial.
 */
export function DateTimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { date, time } = splitDateTime(value);
  return (
    <div className="field">
      <span>{label}</span>
      <div className="dtrow">
        <input
          type="date"
          aria-label={`${label} date`}
          value={date}
          onChange={(e) => {
            // Ignore "clear": a transaction always needs a date.
            if (e.target.value) onChange(joinDateTime(e.target.value, time));
          }}
        />
        <button
          type="button"
          className="picker timepick"
          aria-label={`${label} time`}
          onClick={() => setOpen(true)}
        >
          <span>{displayTime(time)}</span>
          <span>⌄</span>
        </button>
      </div>
      {open && (
        <ClockPicker
          value={time}
          onCancel={() => setOpen(false)}
          onConfirm={(t) => {
            onChange(joinDateTime(date, t));
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
