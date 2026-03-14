// ── DraggableGrid.jsx ─────────────────────────────────────────
// Wraps a list of cards with HTML5 drag-and-drop reordering.
// Calls onReorder(fromIndex, toIndex) when a card is dropped.

import React, { useRef, useState } from "react";
import "./DraggableGrid.css";

export default function DraggableGrid({ items, renderItem, onReorder, className = "" }) {
  const draggable = !!onReorder;
  const dragIndexRef = useRef(null);
  const [dragOver, setDragOver] = useState(null);

  function handleDragStart(e, index) {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setDragImage(e.currentTarget, 20, 20);
  }

  function handleDragOver(e, index) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOver !== index) setDragOver(index);
  }

  function handleDrop(e, index) {
    e.preventDefault();
    const from = dragIndexRef.current;
    if (from !== null && from !== index) {
      onReorder(from, index);
    }
    dragIndexRef.current = null;
    setDragOver(null);
  }

  function handleDragEnd() {
    dragIndexRef.current = null;
    setDragOver(null);
  }

  return (
    <div className={`draggable-grid ${className}`}>
      {items.map((item, index) => (
        <div
          key={item.id}
          className={`draggable-grid__item${dragOver === index ? " draggable-grid__item--over" : ""}${draggable ? " draggable-grid__item--draggable" : ""}`}
          draggable={draggable}
          onDragStart={draggable ? e => handleDragStart(e, index) : undefined}
          onDragOver={draggable ? e => handleDragOver(e, index) : undefined}
          onDrop={draggable ? e => handleDrop(e, index) : undefined}
          onDragEnd={draggable ? handleDragEnd : undefined}
          onDragLeave={draggable ? () => setDragOver(null) : undefined}
        >
          {draggable && (
            <div className="draggable-grid__handle" title="Drag to reorder">
              <span /><span /><span />
            </div>
          )}
          {renderItem(item, index)}
        </div>
      ))}
    </div>
  );
}
