// ═══════════════════════════════════════════════════════════
// audit/commands.rs — Tauri commands for Audit Log
// ═══════════════════════════════════════════════════════════

use super::{audit_path, chain_hash, load_events, save_events, AuditEvent, MAX_EVENTS};
use crate::vault::now_iso;
use serde::{Deserialize, Serialize};

// ── Append a new event ────────────────────────────────────── //
#[tauri::command]
pub fn audit_append(
    category:   String,
    action:     String,
    subject_id: String,
    subject:    String,
    outcome:    String,
    detail:     String,
) -> Result<AuditEvent, String> {
    let mut events = load_events()?;

    let seq       = events.len() as u64 + 1;
    let timestamp = now_iso();
    let prev_hash = events.last().map(|e| e.chain_hash.as_str()).unwrap_or("GENESIS");
    let hash      = chain_hash(prev_hash, seq, &timestamp, &category, &action, &subject_id, &outcome);

    let event = AuditEvent {
        seq,
        timestamp,
        category,
        action,
        subject_id,
        subject,
        outcome,
        detail,
        chain_hash: hash,
    };

    events.push(event.clone());

    // Cap to MAX_EVENTS — drop oldest
    if events.len() > MAX_EVENTS {
        let drop = events.len() - MAX_EVENTS;
        events.drain(..drop);
    }

    save_events(&events)?;
    Ok(event)
}

// ── List events with optional filters ────────────────────── //
#[tauri::command]
pub fn audit_list(
    category: Option<String>,
    outcome:  Option<String>,
    search:   Option<String>,
    limit:    Option<usize>,
) -> Result<Vec<AuditEvent>, String> {
    let events = load_events()?;

    let filtered: Vec<AuditEvent> = events
        .into_iter()
        .rev() // newest first
        .filter(|e| {
            if let Some(ref cat) = category {
                if cat != "all" && &e.category != cat { return false; }
            }
            if let Some(ref out) = outcome {
                if out != "all" && &e.outcome != out { return false; }
            }
            if let Some(ref q) = search {
                let q = q.to_lowercase();
                if !e.subject.to_lowercase().contains(&q)
                    && !e.action.to_lowercase().contains(&q)
                    && !e.detail.to_lowercase().contains(&q)
                    && !e.subject_id.to_lowercase().contains(&q)
                {
                    return false;
                }
            }
            true
        })
        .take(limit.unwrap_or(500))
        .collect();

    Ok(filtered)
}

// ── Verify chain integrity ────────────────────────────────── //
#[tauri::command]
pub fn audit_verify() -> Result<AuditVerifyResult, String> {
    let events = load_events()?;
    let mut broken_at: Option<u64> = None;

    for (i, ev) in events.iter().enumerate() {
        let prev = if i == 0 { "GENESIS" } else { &events[i - 1].chain_hash };
        let expected = chain_hash(prev, ev.seq, &ev.timestamp, &ev.category, &ev.action, &ev.subject_id, &ev.outcome);
        if expected != ev.chain_hash {
            broken_at = Some(ev.seq);
            break;
        }
    }

    Ok(AuditVerifyResult {
        total:     events.len() as u64,
        intact:    broken_at.is_none(),
        broken_at,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuditVerifyResult {
    pub total:     u64,
    pub intact:    bool,
    pub broken_at: Option<u64>,
}

// ── Export as newline-delimited JSON ─────────────────────── //
#[tauri::command]
pub fn audit_export_path() -> Result<String, String> {
    Ok(audit_path().to_string_lossy().to_string())
}

// ── Clear all events (admin action — itself audited) ─────── //
#[tauri::command]
pub fn audit_clear() -> Result<(), String> {
    // Append a "cleared" event before wiping
    let _ = audit_append(
        "system".into(),
        "clear".into(),
        "audit".into(),
        "Audit Log".into(),
        "success".into(),
        "Audit log cleared by user".into(),
    );
    save_events(&[])
}
