const crypto = require("crypto");
const db = require("./db");
const store = require("./store");
const history = require("./history");
const emailGen = require("./emailGen");
const mailer = require("./mailer");
const emailProvider = require("./emailProvider");
const activityLog = require("./activityLog");

// ---------- sequence CRUD ----------
async function listSequences(userId) {
  const result = await db.query(
    `SELECT s.id, s.name, s.created_at,
            COUNT(st.id) AS step_count,
            COUNT(e.id) FILTER (WHERE e.status = 'active') AS active_enrollments
     FROM sequences s
     LEFT JOIN sequence_steps st ON st.sequence_id = s.id
     LEFT JOIN sequence_enrollments e ON e.sequence_id = s.id
     WHERE s.user_id = $1
     GROUP BY s.id
     ORDER BY s.created_at DESC`,
    [userId]
  );
  return result.rows.map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    stepCount: parseInt(r.step_count, 10),
    activeEnrollments: parseInt(r.active_enrollments, 10)
  }));
}

async function getSequence(userId, sequenceId) {
  const seqResult = await db.query("SELECT id, name FROM sequences WHERE id = $1 AND user_id = $2", [
    sequenceId,
    userId
  ]);
  if (!seqResult.rows.length) return null;

  const stepsResult = await db.query(
    "SELECT id, step_order, delay_days, instructions, subject_override FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC",
    [sequenceId]
  );

  return {
    id: seqResult.rows[0].id,
    name: seqResult.rows[0].name,
    steps: stepsResult.rows.map(s => ({
      id: s.id,
      stepOrder: s.step_order,
      delayDays: s.delay_days,
      instructions: s.instructions,
      subjectOverride: s.subject_override
    }))
  };
}

// `steps` fully replaces whatever steps existed before (simplest correct
// model for an edit form — no partial patching of individual steps).
async function saveSequence(userId, { id, name, steps }) {
  const sequenceId = id || crypto.randomUUID();

  if (id) {
    const existing = await db.query("SELECT id FROM sequences WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!existing.rows.length) throw new Error("Sequence not found.");
    await db.query("UPDATE sequences SET name = $1 WHERE id = $2", [name, id]);
    await db.query("DELETE FROM sequence_steps WHERE sequence_id = $1", [id]);
  } else {
    await db.query("INSERT INTO sequences (id, user_id, name) VALUES ($1, $2, $3)", [sequenceId, userId, name]);
  }

  let order = 1;
  for (const step of steps) {
    await db.query(
      `INSERT INTO sequence_steps (id, sequence_id, step_order, delay_days, instructions, subject_override)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        crypto.randomUUID(),
        sequenceId,
        order,
        Math.max(0, parseInt(step.delayDays, 10) || 0),
        step.instructions || "",
        step.subjectOverride || null
      ]
    );
    order += 1;
  }

  return getSequence(userId, sequenceId);
}

async function deleteSequence(userId, sequenceId) {
  const result = await db.query("DELETE FROM sequences WHERE id = $1 AND user_id = $2", [sequenceId, userId]);
  return result.rowCount > 0;
}

// ---------- enrollment ----------
async function enroll(userId, sequenceId, { to, company, contactName, notes, collateralId }) {
  const sequence = await getSequence(userId, sequenceId);
  if (!sequence) throw new Error("Sequence not found.");
  if (!sequence.steps.length) throw new Error("This sequence has no steps yet.");
  if (!to) throw new Error("An email address is required to enroll.");

  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO sequence_enrollments
       (id, user_id, sequence_id, to_email, company, contact_name, notes, collateral_id, status, current_step_order, next_send_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 1, now())`,
    [id, userId, sequenceId, to, company || "", contactName || "", notes || "", collateralId || null]
  );
  return id;
}

async function listEnrollments(userId, { sequenceId, status } = {}) {
  let sql = `
    SELECT e.*, s.name AS sequence_name,
           (SELECT COUNT(*) FROM sequence_steps WHERE sequence_id = e.sequence_id) AS total_steps
    FROM sequence_enrollments e
    JOIN sequences s ON s.id = e.sequence_id
    WHERE e.user_id = $1
  `;
  const params = [userId];
  if (sequenceId) {
    params.push(sequenceId);
    sql += ` AND e.sequence_id = $${params.length}`;
  }
  if (status) {
    params.push(status);
    sql += ` AND e.status = $${params.length}`;
  }
  sql += " ORDER BY e.updated_at DESC";

  const result = await db.query(sql, params);
  return result.rows.map(r => ({
    id: r.id,
    sequenceId: r.sequence_id,
    sequenceName: r.sequence_name,
    to: r.to_email,
    company: r.company,
    contactName: r.contact_name,
    status: r.status,
    currentStepOrder: r.current_step_order,
    totalSteps: parseInt(r.total_steps, 10),
    nextSendAt: r.next_send_at ? r.next_send_at.toISOString() : null,
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString()
  }));
}

async function stopEnrollment(userId, enrollmentId) {
  const result = await db.query(
    `UPDATE sequence_enrollments SET status = 'stopped', updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'active'`,
    [enrollmentId, userId]
  );
  return result.rowCount > 0;
}

// Called by the bounce detector when a sequence-linked send bounces, so the
// sequence doesn't keep emailing a dead address.
async function stopEnrollmentForBounce(sendId) {
  await db.query(
    `UPDATE sequence_enrollments e SET status = 'bounced', updated_at = now()
     FROM sends s
     WHERE s.id = $1 AND s.sequence_enrollment_id = e.id AND e.status = 'active'`,
    [sendId]
  );
}

// Called by the reply detector when a sequence-linked send gets a reply —
// this is the main thing that makes automated sequences safe to run.
async function stopEnrollmentForReply(sendId) {
  await db.query(
    `UPDATE sequence_enrollments e SET status = 'replied', updated_at = now()
     FROM sends s
     WHERE s.id = $1 AND s.sequence_enrollment_id = e.id AND e.status = 'active'`,
    [sendId]
  );
}

// ---------- the scheduler ----------
// Finds every active enrollment whose next step is due, generates and sends
// that step's email, and advances (or completes/errors) the enrollment.
async function processDueEnrollments(baseUrl, limit = 100) {
  const dueResult = await db.query(
    `SELECT id, user_id, sequence_id, to_email, company, contact_name, notes, collateral_id, current_step_order
     FROM sequence_enrollments
     WHERE status = 'active' AND next_send_at <= now()
     ORDER BY next_send_at ASC
     LIMIT $1`,
    [limit]
  );

  let sent = 0;
  let errored = 0;
  let completed = 0;

  for (const row of dueResult.rows) {
    try {
      const result = await processOneEnrollment(row, baseUrl);
      if (result === "sent") {
        sent += 1;
        await activityLog.log(row.user_id, "sequence", "info", `Sent step ${row.current_step_order} to ${row.to_email} (${row.company || "no company"}).`);
      } else if (result === "completed") {
        completed += 1;
        await activityLog.log(row.user_id, "sequence", "info", `Sequence completed for ${row.to_email}.`);
      }
    } catch (e) {
      errored += 1;
      console.error(`Sequence step failed for enrollment ${row.id}:`, e.message);
      await activityLog.log(row.user_id, "sequence", "error", `Step failed for ${row.to_email}: ${e.message}`);
      await db.query(
        `UPDATE sequence_enrollments SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`,
        [row.id, e.message.slice(0, 500)]
      );
    }
  }

  return { processed: dueResult.rows.length, sent, completed, errored };
}

async function processOneEnrollment(enrollment, baseUrl) {
  const stepResult = await db.query(
    "SELECT * FROM sequence_steps WHERE sequence_id = $1 AND step_order = $2",
    [enrollment.sequence_id, enrollment.current_step_order]
  );

  if (!stepResult.rows.length) {
    await db.query(`UPDATE sequence_enrollments SET status = 'completed', updated_at = now() WHERE id = $1`, [
      enrollment.id
    ]);
    return "completed";
  }
  const step = stepResult.rows[0];

  const readiness = await emailProvider.checkReady(enrollment.user_id);
  if (!readiness.ready) {
    throw new Error(readiness.reason);
  }

  const settings = await store.load(enrollment.user_id);
  const collateral = await store.getCollateral(enrollment.user_id, enrollment.collateral_id);

  const { subject, textBody } = await emailGen.generateForProspect(enrollment.user_id, {
    company: enrollment.company,
    contactName: enrollment.contact_name,
    notes: enrollment.notes,
    settings,
    collateral,
    stepInstructions: step.instructions,
    subjectOverride: step.subject_override
  });

  const trackingId = crypto.randomUUID();
  const htmlBody = emailGen.buildTrackedVersion(textBody, {
    trackingId,
    baseUrl,
    trackOpens: settings.trackOpens,
    trackClicks: settings.trackClicks
  });

  let sendResult;
  let sendError = null;
  try {
    sendResult = await mailer.sendOutreachEmail(enrollment.user_id, {
      to: enrollment.to_email,
      subject,
      textBody,
      htmlBody,
      attachCollateral: false,
      collateralId: enrollment.collateral_id
    });
  } catch (e) {
    sendError = e;
  }

  const sequenceName = await getSequenceName(enrollment.sequence_id);
  const historyEntry = await history.add(enrollment.user_id, {
    to: enrollment.to_email,
    company: enrollment.company,
    contactName: enrollment.contact_name,
    subject,
    status: sendError ? "failed" : "sent",
    error: sendError ? sendError.message : null,
    trackingId,
    gmailMessageId: sendResult ? sendResult.id : null,
    gmailThreadId: sendResult ? sendResult.threadId : null,
    batchLabel: `Sequence: ${sequenceName}`
  });

  await db.query(`UPDATE sends SET sequence_enrollment_id = $1, step_order = $2 WHERE id = $3`, [
    enrollment.id,
    step.step_order,
    historyEntry.id
  ]);

  if (sendError) throw sendError;

  const nextStepResult = await db.query(
    "SELECT delay_days FROM sequence_steps WHERE sequence_id = $1 AND step_order = $2",
    [enrollment.sequence_id, enrollment.current_step_order + 1]
  );

  if (nextStepResult.rows.length) {
    const delayDays = nextStepResult.rows[0].delay_days;
    await db.query(
      `UPDATE sequence_enrollments
       SET current_step_order = current_step_order + 1,
           next_send_at = now() + ($2 || ' days')::interval,
           updated_at = now()
       WHERE id = $1`,
      [enrollment.id, delayDays]
    );
  } else {
    await db.query(`UPDATE sequence_enrollments SET status = 'completed', updated_at = now() WHERE id = $1`, [
      enrollment.id
    ]);
  }

  return "sent";
}

async function getSequenceName(sequenceId) {
  const result = await db.query("SELECT name FROM sequences WHERE id = $1", [sequenceId]);
  return result.rows.length ? result.rows[0].name : "Unknown";
}

module.exports = {
  listSequences,
  getSequence,
  saveSequence,
  deleteSequence,
  enroll,
  listEnrollments,
  stopEnrollment,
  stopEnrollmentForBounce,
  stopEnrollmentForReply,
  processDueEnrollments
};
