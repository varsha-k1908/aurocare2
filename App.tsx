import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  PhoneCall,
  Play,
  RotateCcw,
  Search,
  UserPlus,
  CheckCircle2,
  CalendarClock,
  AlertTriangle,
  UserCheck,
  Volume2,
  ArrowUpRight,
  Clock,
  Smartphone,
} from 'lucide-react';
import {
  AutomationExecutionEvent,
  LanguageCode,
  PatientFollowUp,
} from './types/clinic';
import {
  INITIAL_PATIENTS,
  INITIAL_AUTOMATION_EVENTS,
  AVAILABLE_RESCHEDULE_SLOTS,
} from './data/initialPatients';
import {
  SUPPORTED_LANGUAGES,
  buildTwoDayVoiceScript,
  buildWhatsAppReminder,
  buildPatientReplyMessage,
  buildSystemAutoReply,
  speakMultilingualCall,
} from './data/multilingualTemplates';
import { InteractivePatientSimulator } from './components/InteractivePatientSimulator';
import { WeeklyCalendarAndStats } from './components/WeeklyCalendarAndStats';
import { AutomationCodeViewer } from './components/AutomationCodeViewer';
import {
  LiveWhatsAppCallOverlay,
  LiveCallSessionData,
} from './components/LiveWhatsAppCallOverlay';

type QueueFilter = 'all_queue' | 'overdue' | 'two_day_advance' | 'rescheduled' | 'staff_handoff';

export default function App() {
  const [patients, setPatients] = useState<PatientFollowUp[]>(INITIAL_PATIENTS);
  const [events, setEvents] = useState<AutomationExecutionEvent[]>(INITIAL_AUTOMATION_EVENTS);
  const [selectedPatientId, setSelectedPatientId] = useState<string>('pat-103'); // Priya Nair (T-2d Hindi demo patient)
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all_queue');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
  const [liveTelephonyReady, setLiveTelephonyReady] = useState<boolean>(false);
  const [lastCallStatusMessage, setLastCallStatusMessage] = useState<string | null>(null);
  const [recentlyUpdatedId, setRecentlyUpdatedId] = useState<string | null>(null);
  const [demoStepBanner, setDemoStepBanner] = useState<{
    step: number;
    title: string;
    detail: string;
  } | null>(null);
  const [showAddPatientModal, setShowAddPatientModal] = useState<boolean>(false);
  const [isPhoneReceiverMode, setIsPhoneReceiverMode] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return new URLSearchParams(window.location.search).get('mode') === 'phone';
    }
    return false;
  });
  const [liveCallSession, setLiveCallSession] = useState<LiveCallSessionData | null>(null);

  // New Patient Form State
  const [newPatName, setNewPatName] = useState('');
  const [newPatPhone, setNewPatPhone] = useState('+91 6381552097');
  const [newPatLang, setNewPatLang] = useState<LanguageCode>('ta');
  const [newPatProcedure, setNewPatProcedure] = useState('Follicular Ultrasound Scan (Day 10)');
  const [newPatClinician, setNewPatClinician] = useState('Dr. Kavita Rao');

  const stopSpeechRef = useRef<(() => void) | null>(null);
  const demoTimersRef = useRef<number[]>([]);
  const processedWebhooksRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/telephony/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        if (typeof data.liveTelephonyConfigured === 'boolean') {
          setLiveTelephonyReady(data.liveTelephonyConfigured);
        }
        if (data.fromPhoneNumber) {
          setLastCallStatusMessage(
            `Twilio Live Telephony Connected (Caller ID: ${data.fromPhoneNumber} → Target: +91 6381552097 · Tamil). Click "Trigger WhatsApp Call" to ring your phone.`
          );
        } else if (data.errorHint) {
          setLastCallStatusMessage(data.errorHint);
        }
      })
      .catch(() => {
        // Fallback if static preview
      });

    // Real-time cross-device sync for Incoming WhatsApp Call & Patient Reply
    const pollTimer = window.setInterval(() => {
      fetch('/api/live-call/state')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data) return;
          if (data.session) {
            setLiveCallSession((prev) => {
              if (!prev || prev.updatedAt !== data.session.updatedAt) {
                return data.session;
              }
              return prev;
            });
          }
          if (Array.isArray(data.events) && data.events.length > 0) {
            const latest = data.events[0];
            if (latest && !processedWebhooksRef.current.has(latest.id)) {
              processedWebhooksRef.current.add(latest.id);
              if (latest.intent === 'reschedule') {
                handlePatientReschedule(
                  latest.patientId,
                  latest.slot || AVAILABLE_RESCHEDULE_SLOTS[1]
                );
              } else if (latest.intent === 'confirm') {
                handlePatientConfirm(latest.patientId);
              } else if (latest.intent === 'no_answer') {
                handleSimulateNoResponse(latest.patientId);
              }
            }
          }
        })
        .catch(() => {});
    }, 1500);

    return () => window.clearInterval(pollTimer);
  }, []);

  const clearDemoTimers = () => {
    demoTimersRef.current.forEach((t) => window.clearTimeout(t));
    demoTimersRef.current = [];
  };

  const nowTimeLabel = () => {
    const d = new Date();
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const highlightPatientUpdate = (id: string) => {
    setRecentlyUpdatedId(id);
    window.setTimeout(() => {
      setRecentlyUpdatedId((prev) => (prev === id ? null : prev));
    }, 4500);
  };

  const handleUpdatePatientPhone = (patientId: string, phone: string) => {
    setPatients((prev) =>
      prev.map((p) => (p.id === patientId ? { ...p, phone } : p))
    );
  };

  // Trigger the 2-Day Advance Call & WhatsApp in the patient's preferred language
  const handleTriggerTwoDayCall = (patientId: string, customTriggerLabel?: string) => {
    const target = patients.find((p) => p.id === patientId);
    if (!target) return;

    const langConfig = SUPPORTED_LANGUAGES[target.preferredLanguage];
    const voiceData = buildTwoDayVoiceScript(target, target.preferredLanguage);
    const whatsappData = buildWhatsAppReminder(target, target.preferredLanguage);
    const timeStr = nowTimeLabel();

    setLiveCallSession({
      callId: `local-${Date.now()}`,
      status: 'ringing',
      patientId: target.id,
      patientName: target.patientName,
      phone: target.phone,
      language: target.preferredLanguage,
      procedureName: target.procedureName,
      scheduledDayLabel: target.scheduledDayLabel,
      scheduledTime: target.scheduledTime,
      clinician: target.clinician,
      scriptText: voiceData.nativeScript,
      englishTranslation: voiceData.englishTranslation,
      audioUrl: `/api/telephony/tts-audio?lang=${encodeURIComponent(
        target.preferredLanguage
      )}&text=${encodeURIComponent(voiceData.nativeScript.slice(0, 190))}`,
      updatedAt: Date.now(),
    });

    if (stopSpeechRef.current) {
      stopSpeechRef.current();
    }

    if (audioEnabled) {
      stopSpeechRef.current = speakMultilingualCall(
        voiceData.nativeScript,
        langConfig.bcp47,
        () => setIsSpeaking(true),
        () => setIsSpeaking(false)
      );
    }

    // Dispatch WhatsApp Voice Call & Tamil Audio Note via /api/telephony/whatsapp-call
    fetch('/api/telephony/whatsapp-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toPhone: target.phone,
        patientId: target.id,
        patientName: target.patientName,
        language: target.preferredLanguage,
        procedureName: target.procedureName,
        scheduledDayLabel: target.scheduledDayLabel,
        scheduledTime: target.scheduledTime,
        clinician: target.clinician,
        scriptText: voiceData.nativeScript,
        englishTranslation: voiceData.englishTranslation,
        whatsappText: whatsappData.nativeText,
      }),
    })
      .then((r) => r.json())
      .then((resData) => {
        if (resData.mode === 'real_whatsapp_call_dispatched') {
          setLastCallStatusMessage(
            `WhatsApp Voice Call & ${langConfig.name} Audio Note sent to ${resData.to} (SID: ${resData.messageSid}).`
          );
        } else if (resData.message) {
          setLastCallStatusMessage(resData.message);
        }
      })
      .catch(() => {
        setLastCallStatusMessage(
          `Ringing WhatsApp Voice Call in ${langConfig.name} (${langConfig.nativeName}).`
        );
      });

    setPatients((prev) =>
      prev.map((p) => {
        if (p.id !== patientId) return p;
        const nextAttempts = p.attempts + 1;
        return {
          ...p,
          status: 'awaiting_reply',
          attempts: nextAttempts,
          nextRetryIn: `Awaiting patient reply (Attempt ${nextAttempts}/${p.maxAttempts})`,
          lastUpdated: 'Just now',
          callLogs: [
            {
              id: `call-${Date.now()}`,
              timestamp: `Today · ${timeStr}`,
              channel: 'voice_ivr',
              language: p.preferredLanguage,
              triggerType:
                (customTriggerLabel as 'T-48h Advance Auto-Call') || 'T-48h Advance Auto-Call',
              scriptSpoken: voiceData.nativeScript,
              outcome: 'answered_pending',
            },
            ...p.callLogs,
          ],
          conversation: [
            ...p.conversation,
            {
              id: `msg-v-${Date.now()}`,
              sender: 'system_voice',
              timestamp: timeStr,
              language: p.preferredLanguage,
              text: voiceData.nativeScript,
              translatedSubtext: voiceData.englishTranslation,
            },
            {
              id: `msg-w-${Date.now() + 1}`,
              sender: 'system_whatsapp',
              timestamp: timeStr,
              language: p.preferredLanguage,
              text: whatsappData.nativeText,
              translatedSubtext: whatsappData.englishTranslation,
            },
          ],
        };
      })
    );

    setEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: timeStr,
        patientId: target.id,
        patientName: target.patientName,
        language: target.preferredLanguage,
        eventType: 'T_MINUS_2_DAYS_CALL_DISPATCHED',
        summary: `Placed 2-Day Advance Voice Call & WhatsApp in ${langConfig.name} (${langConfig.nativeName})`,
        detail: `Called ${target.phone} for ${target.procedureName} on ${target.scheduledDayLabel} at ${target.scheduledTime}.`,
      },
      ...prev,
    ]);

    highlightPatientUpdate(patientId);
  };

  // Patient presses 1 or replies Confirm
  const handlePatientConfirm = (patientId: string) => {
    const target = patients.find((p) => p.id === patientId);
    if (!target) return;

    const timeStr = nowTimeLabel();
    const patientReply = buildPatientReplyMessage(
      'confirm',
      target.scheduledDayLabel,
      target.scheduledTime,
      target.preferredLanguage
    );
    const botReply = buildSystemAutoReply(
      'confirm',
      target.patientName,
      target.procedureName,
      target.scheduledDayLabel,
      target.scheduledTime,
      target.preferredLanguage
    );

    setPatients((prev) =>
      prev.map((p) => {
        if (p.id !== patientId) return p;
        return {
          ...p,
          status: 'confirmed',
          attempts: Math.max(1, p.attempts),
          nextRetryIn: undefined,
          lastUpdated: 'Just now',
          conversation: [
            ...p.conversation,
            {
              id: `msg-p-${Date.now()}`,
              sender: 'patient',
              timestamp: timeStr,
              language: p.preferredLanguage,
              text: patientReply.nativeText,
              translatedSubtext: patientReply.englishTranslation,
            },
            {
              id: `msg-b-${Date.now() + 1}`,
              sender: 'system_whatsapp',
              timestamp: timeStr,
              language: p.preferredLanguage,
              text: botReply.nativeText,
              translatedSubtext: botReply.englishTranslation,
            },
          ],
        };
      })
    );

    setEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: timeStr,
        patientId: target.id,
        patientName: target.patientName,
        language: target.preferredLanguage,
        eventType: 'PATIENT_CONFIRMED',
        summary: `${target.patientName} confirmed follow-up (${target.scheduledDayLabel} · ${target.scheduledTime})`,
        detail: `Patient replied "1" in ${SUPPORTED_LANGUAGES[target.preferredLanguage].name}. Removed from pending call queue.`,
      },
      ...prev,
    ]);

    highlightPatientUpdate(patientId);
  };

  // Patient presses 2 or replies to Reschedule -> updates staff queue and calendar automatically!
  const handlePatientReschedule = (
    patientId: string,
    slot: { date: string; dayLabel: string; time: string; offsetDays: number }
  ) => {
    const target = patients.find((p) => p.id === patientId);
    if (!target) return;

    const timeStr = nowTimeLabel();
    const patientReply = buildPatientReplyMessage(
      'reschedule',
      slot.dayLabel,
      slot.time,
      target.preferredLanguage
    );
    const botReply = buildSystemAutoReply(
      'reschedule',
      target.patientName,
      target.procedureName,
      slot.dayLabel,
      slot.time,
      target.preferredLanguage
    );

    const oldDay = target.scheduledDayLabel;
    const oldTime = target.scheduledTime;

    setPatients((prev) =>
      prev.map((p) => {
        if (p.id !== patientId) return p;
        return {
          ...p,
          previousDateLabel: p.previousDateLabel || p.scheduledDayLabel,
          previousTime: p.previousTime || p.scheduledTime,
          scheduledDate: slot.date,
          scheduledDayLabel: slot.dayLabel,
          scheduledTime: slot.time,
          dueDateOffsetDays: slot.offsetDays,
          status: 'rescheduled',
          attempts: Math.max(1, p.attempts),
          nextRetryIn: undefined,
          lastUpdated: 'Just now',
          conversation: [
            ...p.conversation,
            {
              id: `msg-p-${Date.now()}`,
              sender: 'patient',
              timestamp: timeStr,
              language: p.preferredLanguage,
              text: patientReply.nativeText,
              translatedSubtext: patientReply.englishTranslation,
            },
            {
              id: `msg-b-${Date.now() + 1}`,
              sender: 'system_whatsapp',
              timestamp: timeStr,
              language: p.preferredLanguage,
              text: botReply.nativeText,
              translatedSubtext: botReply.englishTranslation,
            },
          ],
        };
      })
    );

    setEvents((prev) => [
      {
        id: `evt-cal-${Date.now() + 1}`,
        timestamp: timeStr,
        patientId: target.id,
        patientName: target.patientName,
        language: target.preferredLanguage,
        eventType: 'CALENDAR_AUTO_UPDATED',
        summary: `Calendar & Staff Queue Auto-Updated for ${target.patientName}`,
        detail: `Released ${oldDay} (${oldTime}) and booked ${slot.dayLabel} (${slot.time}) with ${target.clinician}.`,
      },
      {
        id: `evt-res-${Date.now()}`,
        timestamp: timeStr,
        patientId: target.id,
        patientName: target.patientName,
        language: target.preferredLanguage,
        eventType: 'PATIENT_RESCHEDULED',
        summary: `${target.patientName} replied in ${SUPPORTED_LANGUAGES[target.preferredLanguage].name} to reschedule`,
        detail: `Moved ${target.procedureName} from ${oldDay} to ${slot.dayLabel} at ${slot.time}.`,
      },
      ...prev,
    ]);

    highlightPatientUpdate(patientId);
  };

  // Simulate No Response -> Auto-Retry or Staff Handoff after 3 attempts
  const handleSimulateNoResponse = (patientId: string) => {
    const target = patients.find((p) => p.id === patientId);
    if (!target) return;

    const timeStr = nowTimeLabel();
    const nextAttempts = target.attempts + 1;
    const shouldEscalate = nextAttempts >= target.maxAttempts;

    setPatients((prev) =>
      prev.map((p) => {
        if (p.id !== patientId) return p;
        if (shouldEscalate) {
          return {
            ...p,
            attempts: nextAttempts,
            status: 'staff_handoff',
            assignedStaff: 'Nurse Coordinator Ritu Verma',
            escalationReason: `No response after ${nextAttempts} automated attempts in ${SUPPORTED_LANGUAGES[p.preferredLanguage].name}. Handed off for personal coordinator call.`,
            nextRetryIn: undefined,
            lastUpdated: 'Just now',
            conversation: [
              ...p.conversation,
              {
                id: `msg-esc-${Date.now()}`,
                sender: 'automation_engine',
                timestamp: timeStr,
                language: 'en',
                text: `Attempt ${nextAttempts}/${p.maxAttempts} unanswered. Case automatically handed off to Nurse Coordinator Ritu Verma.`,
              },
            ],
          };
        } else {
          return {
            ...p,
            attempts: nextAttempts,
            status: p.dueDateOffsetDays < 0 ? 'overdue' : 'awaiting_reply',
            nextRetryIn: `Auto-Retry #${nextAttempts + 1} scheduled in 2 hours`,
            lastUpdated: 'Just now',
          };
        }
      })
    );

    setEvents((prev) => [
      {
        id: `evt-noans-${Date.now()}`,
        timestamp: timeStr,
        patientId: target.id,
        patientName: target.patientName,
        language: target.preferredLanguage,
        eventType: shouldEscalate ? 'HANDOFF_TO_STAFF' : 'NO_RESPONSE_RETRY_SCHEDULED',
        summary: shouldEscalate
          ? `Escalated ${target.patientName} to Staff Handoff (${nextAttempts}/${target.maxAttempts} Unanswered)`
          : `No answer from ${target.patientName} (Attempt ${nextAttempts}/${target.maxAttempts}) — Auto-Retry Queued`,
        detail: shouldEscalate
          ? `Assigned to Nurse Coordinator Ritu Verma after ${nextAttempts} unanswered multilingual attempts.`
          : `System will automatically retry via WhatsApp & Voice in 2 hours.`,
      },
      ...prev,
    ]);

    highlightPatientUpdate(patientId);
  };

  // Handle free-text reply in simulator
  const handleCustomPatientMessage = (patientId: string, text: string) => {
    const target = patients.find((p) => p.id === patientId);
    if (!target) return;

    const clean = text.toLowerCase();
    const langConfig = SUPPORTED_LANGUAGES[target.preferredLanguage];
    const isReschedule =
      clean === '2' ||
      langConfig.rescheduleKeywords.some((k) => clean.includes(k.toLowerCase())) ||
      clean.includes('reschedule') ||
      clean.includes('monday') ||
      clean.includes('sun') ||
      clean.includes('tue');

    if (isReschedule) {
      handlePatientReschedule(patientId, AVAILABLE_RESCHEDULE_SLOTS[1]);
    } else {
      handlePatientConfirm(patientId);
    }
  };

  const handleChangePatientLanguage = (patientId: string, lang: LanguageCode) => {
    setPatients((prev) =>
      prev.map((p) => (p.id === patientId ? { ...p, preferredLanguage: lang } : p))
    );
  };

  // Batch execute T-48h calls for all patients due in 2 days
  const handleRunBatchTwoDayCalls = () => {
    const t2Patients = patients.filter((p) => p.dueDateOffsetDays === 2);
    t2Patients.forEach((p, idx) => {
      window.setTimeout(() => {
        handleTriggerTwoDayCall(p.id, 'T-48h Advance Auto-Call');
      }, idx * 400);
    });
  };

  // Full Automated End-to-End Hackathon Demo ("WHAT TO SHOW IN THE DEMO")
  const handleRunInteractiveDemo = () => {
    clearDemoTimers();
    const demoPatientId = 'pat-103'; // Priya Nair (Due in 2 days: Sat, Oct 10 · 09:30 AM, Preferred Language: Hindi)

    // Ensure Priya is in her initial T-2 days state first if she was already rescheduled
    setPatients((prev) =>
      prev.map((p) =>
        p.id === demoPatientId
          ? {
              ...INITIAL_PATIENTS.find((ip) => ip.id === demoPatientId)!,
              preferredLanguage: p.preferredLanguage,
            }
          : p
      )
    );
    setSelectedPatientId(demoPatientId);
    setQueueFilter('all_queue');

    setDemoStepBanner({
      step: 1,
      title: 'Step 1 of 3 · T-48h Follow-Up Detected (2 Days Before Appointment)',
      detail:
        'Priya Nair (+91 6381552097) is scheduled for her Day-10 Follicular Ultrasound Scan in 2 days (Sat, Oct 10 at 09:30 AM). Preferred language: Tamil (தமிழ்).',
    });

    const t1 = window.setTimeout(() => {
      setDemoStepBanner({
        step: 2,
        title: 'Step 2 of 3 · Automated 2-Day Advance Call & WhatsApp Sent in Tamil (தமிழ்)',
        detail:
          'System places outbound Voice IVR call and WhatsApp reminder to +91 6381552097 in Tamil without staff picking up the phone.',
      });
      handleTriggerTwoDayCall(demoPatientId, 'T-48h Advance Auto-Call');
    }, 1400);

    const t2 = window.setTimeout(() => {
      setDemoStepBanner({
        step: 3,
        title: 'Step 3 of 3 · Patient Replies "2" to Reschedule → Staff Queue & Calendar Self-Update',
        detail:
          'Priya replies in Tamil to reschedule to Mon, Oct 12 at 11:15 AM. Watch the "Calls for Today" list, Weekly Summary, and Sat Oct 10 → Mon Oct 12 Calendar update automatically!',
      });
      handlePatientReschedule(demoPatientId, AVAILABLE_RESCHEDULE_SLOTS[1]); // Mon, Oct 12 · 11:15 AM
    }, 5200);

    demoTimersRef.current = [t1, t2];
  };

  const handleResetDemo = () => {
    clearDemoTimers();
    if (stopSpeechRef.current) stopSpeechRef.current();
    setIsSpeaking(false);
    setPatients(INITIAL_PATIENTS);
    setEvents(INITIAL_AUTOMATION_EVENTS);
    setSelectedPatientId('pat-103');
    setDemoStepBanner(null);
    setQueueFilter('all_queue');
  };

  const handleAddPatient = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPatName.trim()) return;
    const newId = `pat-${Date.now()}`;
    const newPatient: PatientFollowUp = {
      id: newId,
      mrn: `FC-${Math.floor(9100 + Math.random() * 800)}`,
      patientName: newPatName.trim(),
      age: 32,
      phone: newPatPhone.trim() || '+91 98201 44910',
      preferredLanguage: newPatLang,
      cycleType: 'IVF Antagonist Protocol',
      procedureName: newPatProcedure,
      clinician: newPatClinician,
      clinicalUrgency: 'Time-Critical Hormone Window',
      prepInstruction: 'Arrive 15 minutes early for morning hormone blood draw and ultrasound.',
      dueDateOffsetDays: 2,
      scheduledDate: '2026-10-10',
      scheduledDayLabel: 'Sat, Oct 10',
      scheduledTime: '10:30 AM',
      status: 'due_in_2_days',
      attempts: 0,
      maxAttempts: 3,
      nextRetryIn: 'Scheduled T-48h Auto-Call Ready',
      callLogs: [],
      conversation: [],
      lastUpdated: 'Just now',
    };

    setPatients((prev) => [newPatient, ...prev]);
    setSelectedPatientId(newId);
    setShowAddPatientModal(false);
    setNewPatName('');

    // Immediately trigger the 2-day advance call for the newly added T-48h patient
    window.setTimeout(() => {
      handleTriggerTwoDayCall(newId, 'T-48h Advance Auto-Call');
    }, 300);
  };

  // Sort "Calls for Today" automatically:
  // 1. Most overdue cases at the very top (lowest dueDateOffsetDays first)
  // 2. T-2 days advance call cases (dueDateOffsetDays === 2 & unconfirmed)
  // 3. Staff handoff cases
  // 4. Confirmed / Rescheduled / Completed cases
  const sortedAndFilteredPatients = useMemo(() => {
    const statusPriority = (p: PatientFollowUp): number => {
      if (p.status === 'overdue') return 1;
      if (p.status === 'due_in_2_days' || p.status === 'awaiting_reply') return 2;
      if (p.status === 'staff_handoff') return 3;
      if (p.status === 'rescheduled') return 4;
      if (p.status === 'confirmed') return 5;
      return 6;
    };

    return patients
      .filter((p) => {
        if (queueFilter === 'overdue') return p.status === 'overdue';
        if (queueFilter === 'two_day_advance')
          return p.dueDateOffsetDays === 2 || p.status === 'due_in_2_days' || p.status === 'awaiting_reply';
        if (queueFilter === 'rescheduled') return p.status === 'rescheduled';
        if (queueFilter === 'staff_handoff') return p.status === 'staff_handoff';
        return true;
      })
      .filter((p) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
          p.patientName.toLowerCase().includes(q) ||
          p.mrn.toLowerCase().includes(q) ||
          p.procedureName.toLowerCase().includes(q) ||
          SUPPORTED_LANGUAGES[p.preferredLanguage].name.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const prioDiff = statusPriority(a) - statusPriority(b);
        if (prioDiff !== 0) return prioDiff;
        return a.dueDateOffsetDays - b.dueDateOffsetDays;
      });
  }, [patients, queueFilter, searchQuery]);

  const selectedPatient =
    patients.find((p) => p.id === selectedPatientId) || patients[0];

  const staffHandoffCases = patients.filter((p) => p.status === 'staff_handoff');

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-slate-900">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-8">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          className="text-lg font-bold tracking-tight text-slate-900 font-display whitespace-nowrap shrink-0"
        >
          AuraCare Fertility
        </a>

        {/* Zone 2: 4–5 concise single-line navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a
            href="#calls-for-today"
            className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Morning Queue
          </a>
          <a
            href="#patient-simulator"
            className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Patient Simulator
          </a>
          <a
            href="#weekly-calendar"
            className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Calendar & Outcomes
          </a>
          <a
            href="#staff-handoff"
            className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Staff Handoff ({staffHandoffCases.length})
          </a>
          <a
            href="#automation-code"
            className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            2-Day Call Code
          </a>
        </nav>

        {/* Zone 3: 1 Primary Action Button */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleRunInteractiveDemo}
            className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1.5"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Run Live Demo</span>
          </button>
        </div>
      </header>

      {/* Main Content Container (1440px Desktop Presence) */}
      <main id="top" className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-8">
        {/* Workspace Command Toolbar */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-1 max-w-3xl">
            <div className="text-xs text-slate-500 flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-teal-800">Automated Follow-Up & T-48h Call Engine</span>
              <span aria-hidden="true">·</span>
              <span>Clinic Date: Thu, Oct 8, 2026</span>
              <span aria-hidden="true">·</span>
              <span>2-Day Advance Target: Sat, Oct 10, 2026</span>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
              Fertility Follow-Up Queue & Multilingual 2-Day Pre-Call Automation
            </h1>
            <p className="text-sm text-slate-600">
              Automatically calls and messages patients <strong className="font-semibold text-slate-800">2 days before</strong> their ultrasound or blood draw in their preferred language, ranks overdue cases at the top each morning, self-updates the clinic calendar when patients reschedule, and escalates after 3 unanswered attempts.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                setIsPhoneReceiverMode(true);
                handleTriggerTwoDayCall(selectedPatient.id, 'T-48h Advance Auto-Call');
              }}
              className="px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>Receive Incoming WhatsApp Call (+91 6381552097)</span>
            </button>

            <button
              type="button"
              onClick={handleRunBatchTwoDayCalls}
              className="px-3.5 py-2 text-xs font-semibold text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <PhoneCall className="w-3.5 h-3.5 text-teal-700" />
              <span>Call All T-2 Day Patients</span>
            </button>

            <button
              type="button"
              onClick={() => setShowAddPatientModal(true)}
              className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Add Follow-Up</span>
            </button>

            <button
              type="button"
              onClick={handleResetDemo}
              className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Demo</span>
            </button>
          </div>
        </section>

        {/* Live Guided Demo Step Banner (Appears when Run Live Demo is clicked) */}
        {demoStepBanner && (
          <section
            aria-live="polite"
            className="bg-teal-950 text-white border border-teal-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          >
            <div className="space-y-1">
              <div className="text-xs font-mono text-teal-300 flex items-center gap-2">
                <span>LIVE DEMO WALKTHROUGH</span>
                <span aria-hidden="true">·</span>
                <span>PATIENT: PRIYA NAIR (+91 6381552097 · TAMIL · தமிழ்)</span>
              </div>
              <div className="text-sm font-semibold text-white">{demoStepBanner.title}</div>
              <p className="text-xs text-teal-100/90">{demoStepBanner.detail}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setDemoStepBanner(null)}
                className="px-3 py-1.5 text-xs font-medium text-teal-200 hover:text-white border border-teal-800 rounded-lg whitespace-nowrap shrink-0"
              >
                Dismiss
              </button>
            </div>
          </section>
        )}

        {/* Primary Split Workspace: Left 7 Cols = "Calls for Today" Auto-Prioritized List | Right 5 Cols = Interactive Patient Phone Simulator */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left 7 Columns: "Calls for Today" Queue */}
          <section
            id="calls-for-today"
            aria-labelledby="morning-queue-heading"
            className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden"
          >
            <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="morning-queue-heading" className="text-base font-semibold text-slate-900">
                  “Calls for Today” — Auto-Built Morning Priority Queue
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Sorted automatically at 08:00 AM: most overdue cases first, followed by T-2 Day advance multilingual calls.
                </p>
              </div>
              <div className="text-xs text-slate-500 font-mono tabular-nums">
                Showing {sortedAndFilteredPatients.length} of {patients.length} patients
              </div>
            </div>

            {/* Filter & Search Bar */}
            <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-1 p-1 bg-slate-200/80 rounded-lg overflow-x-auto">
                {(
                  [
                    { id: 'all_queue', label: 'All Patients' },
                    { id: 'overdue', label: 'Overdue First' },
                    { id: 'two_day_advance', label: 'Due in 2 Days (T-48h)' },
                    { id: 'rescheduled', label: 'Rescheduled' },
                    { id: 'staff_handoff', label: 'Staff Handoff' },
                  ] as { id: QueueFilter; label: string }[]
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setQueueFilter(tab.id)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      queueFilter === tab.id
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="relative min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search patient, language, scan..."
                  className="w-full bg-white border border-slate-300 rounded-lg pl-8 pr-3 py-1 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>

            {/* High-Density Queue Rows */}
            <div className="divide-y divide-slate-200">
              {sortedAndFilteredPatients.length === 0 ? (
                <div className="py-12 px-6 text-center space-y-2">
                  <p className="text-sm font-medium text-slate-700">No follow-ups match this filter</p>
                  <p className="text-xs text-slate-500">
                    Try switching to “All Patients” or reset the demo data.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setQueueFilter('all_queue');
                      setSearchQuery('');
                    }}
                    className="mt-2 px-3 py-1.5 text-xs font-medium text-teal-700 border border-teal-700/30 rounded-lg hover:bg-teal-50"
                  >
                    Show All Follow-Ups
                  </button>
                </div>
              ) : (
                sortedAndFilteredPatients.map((pat, index) => {
                  const isSelected = pat.id === selectedPatient.id;
                  const isJustUpdated = pat.id === recentlyUpdatedId;
                  const lang = SUPPORTED_LANGUAGES[pat.preferredLanguage];

                  const dueDescriptor =
                    pat.dueDateOffsetDays < 0
                      ? `${Math.abs(pat.dueDateOffsetDays)}d Overdue`
                      : pat.dueDateOffsetDays === 0
                      ? 'Due Today'
                      : pat.dueDateOffsetDays === 2
                      ? 'Due in 2 Days (T-48h Auto-Call)'
                      : `In ${pat.dueDateOffsetDays} Days`;

                  return (
                    <div
                      key={pat.id}
                      onClick={() => setSelectedPatientId(pat.id)}
                      className={`p-4 transition-colors cursor-pointer ${
                        isJustUpdated
                          ? 'bg-teal-50/70'
                          : isSelected
                          ? 'bg-slate-50'
                          : 'bg-white hover:bg-slate-50/60'
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        {/* Left Column: Rank, Name, Unboxed Metadata */}
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono tabular-nums text-slate-400">
                              #{String(index + 1).padStart(2, '0')}
                            </span>
                            <span className="text-sm font-semibold text-slate-900">
                              {pat.patientName}
                            </span>
                            <span className="text-xs text-slate-400" aria-hidden="true">
                              ·
                            </span>
                            <span className="text-xs font-mono text-slate-500">{pat.mrn}</span>
                            <span className="text-xs text-slate-400" aria-hidden="true">
                              ·
                            </span>
                            <span className="text-xs font-medium text-slate-700">
                              {lang.name} ({lang.nativeName})
                            </span>
                          </div>

                          <div className="text-xs text-slate-700 font-medium">
                            {pat.procedureName}{' '}
                            <span className="text-slate-400 font-normal">
                              with {pat.clinician} ({pat.cycleType})
                            </span>
                          </div>

                          {/* Unboxed Status & Schedule Line (Zero-Pill Discipline) */}
                          <div className="text-xs text-slate-500 flex flex-wrap items-center gap-1.5 pt-0.5">
                            <span
                              className={`font-semibold ${
                                pat.dueDateOffsetDays < 0 && pat.status === 'overdue'
                                  ? 'text-amber-700'
                                  : pat.dueDateOffsetDays === 2
                                  ? 'text-teal-800'
                                  : 'text-slate-700'
                              }`}
                            >
                              {dueDescriptor}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums text-slate-700">
                              {pat.scheduledDayLabel} at {pat.scheduledTime}
                            </span>
                            {pat.previousDateLabel && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-slate-400 line-through font-mono tabular-nums">
                                  Was {pat.previousDateLabel} {pat.previousTime}
                                </span>
                              </>
                            )}
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              Attempts: {pat.attempts}/{pat.maxAttempts}
                            </span>
                          </div>
                        </div>

                        {/* Right Column: Semantic Status & Quick Call Action */}
                        <div className="flex items-center gap-3 shrink-0 self-start sm:self-center">
                          <div className="text-right">
                            {pat.status === 'overdue' && (
                              <div className="flex items-center gap-1 text-xs font-semibold text-amber-700">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                <span>Overdue · Auto-Retry</span>
                              </div>
                            )}
                            {pat.status === 'due_in_2_days' && (
                              <div className="flex items-center gap-1 text-xs font-semibold text-teal-800">
                                <Clock className="w-3.5 h-3.5 shrink-0" />
                                <span>T-2 Days · Ready to Call</span>
                              </div>
                            )}
                            {pat.status === 'awaiting_reply' && (
                              <div className="flex items-center gap-1 text-xs font-semibold text-teal-700">
                                <Volume2 className="w-3.5 h-3.5 shrink-0" />
                                <span>Called · Awaiting Reply</span>
                              </div>
                            )}
                            {pat.status === 'rescheduled' && (
                              <div className="flex items-center gap-1 text-xs font-semibold text-teal-700">
                                <CalendarClock className="w-3.5 h-3.5 shrink-0" />
                                <span>Auto-Rescheduled</span>
                              </div>
                            )}
                            {pat.status === 'confirmed' && (
                              <div className="flex items-center gap-1 text-xs font-semibold text-emerald-700">
                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                <span>Confirmed by Patient</span>
                              </div>
                            )}
                            {pat.status === 'completed' && (
                              <div className="flex items-center gap-1 text-xs font-semibold text-emerald-700">
                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                <span>Completed</span>
                              </div>
                            )}
                            {pat.status === 'staff_handoff' && (
                              <div className="flex items-center gap-1 text-xs font-semibold text-rose-700">
                                <UserCheck className="w-3.5 h-3.5 shrink-0" />
                                <span>Handed to Staff</span>
                              </div>
                            )}
                            {pat.nextRetryIn && (
                              <div className="text-[11px] text-slate-400 mt-0.5">
                                {pat.nextRetryIn}
                              </div>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedPatientId(pat.id);
                              handleTriggerTwoDayCall(pat.id, 'T-48h Advance Auto-Call');
                            }}
                            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-100 transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <PhoneCall className="w-3 h-3 text-teal-700" />
                            <span>Call ({lang.code.toUpperCase()})</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Right 5 Columns: Interactive Patient Phone, Voice IVR & WhatsApp Simulator */}
          <div id="patient-simulator" className="lg:col-span-5">
            <InteractivePatientSimulator
              patient={selectedPatient}
              isSpeaking={isSpeaking}
              audioEnabled={audioEnabled}
              liveTelephonyReady={liveTelephonyReady}
              lastCallStatusMessage={lastCallStatusMessage}
              onToggleAudio={() => {
                if (audioEnabled && stopSpeechRef.current) {
                  stopSpeechRef.current();
                }
                setAudioEnabled(!audioEnabled);
              }}
              onTriggerTwoDayCall={(id) => handleTriggerTwoDayCall(id, 'T-48h Advance Auto-Call')}
              onPatientConfirm={handlePatientConfirm}
              onPatientReschedule={handlePatientReschedule}
              onSimulateNoResponse={handleSimulateNoResponse}
              onChangePatientLanguage={handleChangePatientLanguage}
              onUpdatePatientPhone={handleUpdatePatientPhone}
              onCustomPatientMessage={handleCustomPatientMessage}
            />
          </div>
        </div>

        {/* Staff Handoff Escalation Desk (Cases where patient did not respond after 3 attempts) */}
        <section
          id="staff-handoff"
          aria-labelledby="handoff-heading"
          className="bg-white border border-slate-200 rounded-xl overflow-hidden"
        >
          <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <UserCheck className="w-4 h-4 text-rose-600 shrink-0" />
              <div>
                <h2 id="handoff-heading" className="text-base font-semibold text-slate-900">
                  Staff Action Desk — Automatic Handoffs After Unanswered Retries
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Staff only pick up the phone for patients who did not respond after 3 automated Voice & WhatsApp attempts.
                </p>
              </div>
            </div>
            <div className="text-xs font-mono tabular-nums text-slate-500">
              Active Staff Handoffs: {staffHandoffCases.length}
            </div>
          </div>

          <div className="divide-y divide-slate-200">
            {staffHandoffCases.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                Zero cases currently waiting on manual staff intervention.
              </div>
            ) : (
              staffHandoffCases.map((pat) => {
                const lang = SUPPORTED_LANGUAGES[pat.preferredLanguage];
                return (
                  <div
                    key={pat.id}
                    className="px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                        <span>{pat.patientName}</span>
                        <span className="text-slate-400 font-normal" aria-hidden="true">
                          ·
                        </span>
                        <span className="text-xs font-mono text-slate-500">{pat.phone}</span>
                        <span className="text-slate-400 font-normal" aria-hidden="true">
                          ·
                        </span>
                        <span className="text-xs font-medium text-rose-700">
                          Assigned to {pat.assignedStaff || 'Nurse Coordinator Ritu Verma'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">
                        {pat.procedureName} ({pat.scheduledDayLabel} at {pat.scheduledTime}) · Preferred Language:{' '}
                        <strong className="text-slate-800">
                          {lang.name} ({lang.nativeName})
                        </strong>
                      </p>
                      <p className="text-xs text-slate-500">{pat.escalationReason}</p>
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          handlePatientReschedule(pat.id, AVAILABLE_RESCHEDULE_SLOTS[2])
                        }
                        className="px-3 py-1.5 text-xs font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Log Coordinator Reschedule
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePatientConfirm(pat.id)}
                        className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <span>Mark Resolved & Confirmed</span>
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Weekly Summary View & Auto-Syncing Clinic Calendar */}
        <div id="weekly-calendar">
          <WeeklyCalendarAndStats
            patients={patients}
            selectedPatientId={selectedPatient.id}
            recentlyUpdatedId={recentlyUpdatedId}
            onSelectPatient={(id) => setSelectedPatientId(id)}
          />
        </div>

        {/* Complete 2-Day Advance Call Code & Live Webhook Log */}
        <AutomationCodeViewer
          patients={patients}
          events={events}
          onRunBatchTwoDayCalls={handleRunBatchTwoDayCalls}
        />
      </main>

      {/* Add Patient Follow-Up Modal */}
      {showAddPatientModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 space-y-4 shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-semibold text-slate-900">
                Add Patient Follow-Up (T-2 Day Auto-Call)
              </h3>
              <button
                type="button"
                onClick={() => setShowAddPatientModal(false)}
                className="text-xs text-slate-500 hover:text-slate-900"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleAddPatient} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Patient Full Name
                </label>
                <input
                  type="text"
                  required
                  value={newPatName}
                  onChange={(e) => setNewPatName(e.target.value)}
                  placeholder="e.g., Ananya Sharma"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Phone Number
                  </label>
                  <input
                    type="text"
                    value={newPatPhone}
                    onChange={(e) => setNewPatPhone(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Preferred Language
                  </label>
                  <select
                    value={newPatLang}
                    onChange={(e) => setNewPatLang(e.target.value as LanguageCode)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    {Object.values(SUPPORTED_LANGUAGES).map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.name} ({l.nativeName})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Fertility Consultation / Procedure
                </label>
                <select
                  value={newPatProcedure}
                  onChange={(e) => setNewPatProcedure(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  <option value="Follicular Ultrasound Scan (Day 10)">
                    Follicular Ultrasound Scan (Day 10)
                  </option>
                  <option value="Beta hCG Blood Test (14dpt)">
                    Beta hCG Blood Test (14dpt)
                  </option>
                  <option value="Trigger Shot (Ovidrel) Timing Consult">
                    Trigger Shot (Ovidrel) Timing Consult
                  </option>
                  <option value="Endometrial Lining & Progesterone Check">
                    Endometrial Lining & Progesterone Check
                  </option>
                  <option value="Day-5 Blastocyst Transfer Check-In">
                    Day-5 Blastocyst Transfer Check-In
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Lead Clinician
                </label>
                <select
                  value={newPatClinician}
                  onChange={(e) => setNewPatClinician(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  <option value="Dr. Kavita Rao">Dr. Kavita Rao</option>
                  <option value="Dr. Elena Rostova">Dr. Elena Rostova</option>
                  <option value="Dr. Arjun Mehta">Dr. Arjun Mehta</option>
                </select>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddPatientModal(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
                >
                  Add & Trigger 2-Day Advance Call
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Full-Screen Incoming WhatsApp Voice Call Overlay & Cross-Device Mobile Receiver */}
      <LiveWhatsAppCallOverlay
        session={liveCallSession}
        isPhoneReceiverMode={isPhoneReceiverMode}
        onExitPhoneReceiverMode={() => setIsPhoneReceiverMode(false)}
        onAnswerCall={() => {
          if (stopSpeechRef.current) stopSpeechRef.current();
          fetch('/api/live-call/answer', { method: 'POST' })
            .then((r) => r.json())
            .then((d) => {
              if (d.session) setLiveCallSession(d.session);
            })
            .catch(() => {});
        }}
        onConfirmFromCall={(patId) => {
          handlePatientConfirm(patId);
          setIsPhoneReceiverMode(false);
          fetch('/api/live-call/respond', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patientId: patId, intent: 'confirm' }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (d.session) setLiveCallSession(d.session);
            })
            .catch(() => {});
        }}
        onRescheduleFromCall={(patId, slot) => {
          handlePatientReschedule(patId, slot);
          setIsPhoneReceiverMode(false);
          fetch('/api/live-call/respond', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patientId: patId, intent: 'reschedule', slot }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (d.session) setLiveCallSession(d.session);
            })
            .catch(() => {});
        }}
        onDeclineOrNoAnswer={(patId) => {
          handleSimulateNoResponse(patId);
          setIsPhoneReceiverMode(false);
          fetch('/api/live-call/respond', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patientId: patId, intent: 'no_answer' }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (d.session) setLiveCallSession(d.session);
            })
            .catch(() => {});
        }}
        onTriggerTestCallOnPhone={() => {
          handleTriggerTwoDayCall(selectedPatient.id, 'T-48h Advance Auto-Call');
        }}
      />

      {/* Quiet Footer */}
      <footer className="mt-12 border-t border-slate-200 bg-white px-6 py-4">
        <div className="max-w-[1440px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <span>AuraCare Fertility Clinic Operations · Automated T-48h Multilingual Outreach</span>
          <div className="flex items-center gap-4">
            <a href="#calls-for-today" className="hover:text-slate-900">
              Morning Queue
            </a>
            <a href="#weekly-calendar" className="hover:text-slate-900">
              Weekly Calendar
            </a>
            <a href="#automation-code" className="hover:text-slate-900">
              2-Day Pre-Call Code
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
