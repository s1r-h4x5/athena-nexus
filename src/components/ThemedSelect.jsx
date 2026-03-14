// components/ThemedSelect.jsx
// Reusable custom dropdown — replaces every native <select> in the app.
// Matches the sort dropdown from Dashboard.
//
// Usage:
//   <ThemedSelect
//     value={outcome}
//     options={[{ value: "all", label: "All outcomes" }, ...]}
//     onChange={setOutcome}
//   />

import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import "./ThemedSelect.css";

export default function ThemedSelect({ value, options, onChange, className = "" }) {
  const [open, setOpen] = useState(false);
  const ref  = useRef(null);
  const selected = options.find(o => o.value === value) || options[0];

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className={`ts-wrap ${className}`} ref={ref}>
      <button
        className="ts-trigger"
        onClick={() => setOpen(o => !o)}
        type="button"
      >
        <span className="ts-trigger__label">{selected?.label}</span>
        <ChevronDown
          size={10}
          className={`ts-trigger__chevron ${open ? "ts-trigger__chevron--open" : ""}`}
        />
      </button>

      {open && (
        <div className="ts-menu">
          {options.map(o => (
            <button
              key={o.value}
              type="button"
              className={`ts-item ${o.value === value ? "ts-item--active" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span className="ts-item__check">
                {o.value === value && <Check size={10} />}
              </span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
