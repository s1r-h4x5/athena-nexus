// ═══════════════════════════════════════════════════════════
// components/CategoryModal.jsx
// Add / edit a sidebar category — name + icon picker
// ═══════════════════════════════════════════════════════════

import React, { useState, useEffect, useRef } from "react";
import {
  X, Grid, Shield, ShieldCheck, Activity, Search, Eye,
  Network, Wrench, Database, Lock, ClipboardList, Cpu,
  BookOpen, Settings, Camera, Zap, Target, Terminal,
  AlertTriangle, Crosshair, Globe, HardDrive, Layers,
  Package, Radio, Server, Wifi, Box, Bug, Trash2,
} from "lucide-react";
import "./CategoryModal.css";

// All available icons with display labels
const ICON_OPTIONS = [
  { key: "Shield",        Icon: Shield,        label: "Shield"        },
  { key: "ShieldCheck",   Icon: ShieldCheck,   label: "Shield Check"  },
  { key: "Activity",      Icon: Activity,      label: "Activity"      },
  { key: "Search",        Icon: Search,        label: "Search"        },
  { key: "Eye",           Icon: Eye,           label: "Eye"           },
  { key: "Network",       Icon: Network,       label: "Network"       },
  { key: "Wrench",        Icon: Wrench,        label: "Wrench"        },
  { key: "Database",      Icon: Database,      label: "Database"      },
  { key: "Lock",          Icon: Lock,          label: "Lock"          },
  { key: "ClipboardList", Icon: ClipboardList, label: "Clipboard"     },
  { key: "Cpu",           Icon: Cpu,           label: "CPU"           },
  { key: "BookOpen",      Icon: BookOpen,      label: "Book"          },
  { key: "Camera",        Icon: Camera,        label: "Camera"        },
  { key: "Zap",           Icon: Zap,           label: "Zap"           },
  { key: "Target",        Icon: Target,        label: "Target"        },
  { key: "Terminal",      Icon: Terminal,      label: "Terminal"      },
  { key: "AlertTriangle", Icon: AlertTriangle, label: "Alert"         },
  { key: "Crosshair",     Icon: Crosshair,     label: "Crosshair"     },
  { key: "Globe",         Icon: Globe,         label: "Globe"         },
  { key: "HardDrive",     Icon: HardDrive,     label: "Hard Drive"    },
  { key: "Layers",        Icon: Layers,        label: "Layers"        },
  { key: "Package",       Icon: Package,       label: "Package"       },
  { key: "Radio",         Icon: Radio,         label: "Radio"         },
  { key: "Server",        Icon: Server,        label: "Server"        },
  { key: "Wifi",          Icon: Wifi,          label: "Wifi"          },
  { key: "Box",           Icon: Box,           label: "Box"           },
  { key: "Bug",           Icon: Bug,           label: "Bug"           },
  { key: "Grid",          Icon: Grid,          label: "Grid"          },
  { key: "Settings",      Icon: Settings,      label: "Settings"      },
];

export default function CategoryModal({ existing, onConfirm, onDelete, onClose }) {
  const isEdit = !!existing;
  const [name, setName]           = useState(existing?.label || "");
  const [icon, setIcon]           = useState(existing?.icon  || "Shield");
  const [error, setError]         = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef                  = useRef(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 60);
  }, []);

  function handleSubmit(e) {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError("Name is required."); return; }
    if (trimmed.length > 32) { setError("Max 32 characters."); return; }
    onConfirm({ name: trimmed, icon });
  }

  const SelectedIcon = ICON_OPTIONS.find(o => o.key === icon)?.Icon || Shield;

  return (
    <div className="cat-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cat-modal">

        {/* Header */}
        <div className="cat-modal__header">
          <div className="cat-modal__title-block">
            <span className="cat-modal__tag">// {isEdit ? "EDIT" : "NEW"}</span>
            <h2 className="cat-modal__title">{isEdit ? "Edit Category" : "Add Category"}</h2>
          </div>
          <button className="cat-modal__close" onClick={onClose}><X size={15} /></button>
        </div>

        {/* Preview strip */}
        <div className="cat-modal__preview">
          <div className="cat-modal__preview-item">
            <SelectedIcon size={16} />
            <span>{name || "Category name"}</span>
          </div>
        </div>

        {/* Form */}
        <form className="cat-modal__body" onSubmit={handleSubmit}>

          {/* Name */}
          <label className="cat-modal__label">NAME</label>
          <input
            ref={inputRef}
            className={`cat-modal__input${error ? " cat-modal__input--error" : ""}`}
            value={name}
            onChange={e => { setName(e.target.value); setError(""); }}
            placeholder="e.g. Red Team"
            maxLength={32}
            spellCheck={false}
          />
          {error && <span className="cat-modal__error">{error}</span>}

          {/* Icon picker */}
          <label className="cat-modal__label" style={{ marginTop: 16 }}>ICON</label>
          <div className="cat-modal__icon-grid">
            {ICON_OPTIONS.map(({ key, Icon, label }) => (
              <button
                key={key}
                type="button"
                className={`cat-modal__icon-btn${icon === key ? " cat-modal__icon-btn--selected" : ""}`}
                onClick={() => setIcon(key)}
                title={label}
              >
                <Icon size={16} />
              </button>
            ))}
          </div>

          {/* Footer */}
          <div className="cat-modal__footer">
            {isEdit && !confirmDelete && (
              <button
                type="button"
                className="cat-modal__btn cat-modal__btn--delete"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={12} /> Delete
              </button>
            )}
            {isEdit && confirmDelete && (
              <div className="cat-modal__delete-confirm">
                <span className="cat-modal__delete-msg">Delete this category?</span>
                <button type="button" className="cat-modal__btn cat-modal__btn--delete-confirm" onClick={() => onDelete(existing)}>
                  Yes, Delete
                </button>
                <button type="button" className="cat-modal__btn cat-modal__btn--cancel" onClick={() => setConfirmDelete(false)}>
                  No
                </button>
              </div>
            )}
            {!confirmDelete && (
              <>
                <button type="button" className="cat-modal__btn cat-modal__btn--cancel" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="cat-modal__btn cat-modal__btn--confirm">
                  {isEdit ? "Save Changes" : "Add Category"}
                </button>
              </>
            )}
          </div>

        </form>
      </div>
    </div>
  );
}
