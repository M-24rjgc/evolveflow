import React, { useState, useEffect, useRef } from 'react';
import { callCapability, onSidecarEvent } from '../lib/tauri';
import { useI18n } from '../lib/i18n';

// ── Types ──────────────────────────────────────────────────────

type BuddyMood = 'happy' | 'neutral' | 'encouraging' | 'concerned';
type BuddyLevel = 'full' | 'minimal' | 'off';

interface PersonalityTraits {
  encouragementFrequency: number;
  severityTone: number;
  formality: number;
  brevity: number;
}

interface BuddyWidgetProps {
  pendingCount: number;
}

// ── Mood Visuals ───────────────────────────────────────────────

const MOOD_EMOJI: Record<BuddyMood, string> = {
  happy: '\u{1F60A}',
  concerned: '\u{1F61F}',
  encouraging: '\u{1F4AA}',
  neutral: '\u{1F610}',
};

const MOOD_COLORS: Record<BuddyMood, { bg: string; accent: string; text: string }> = {
  happy: { bg: '#e8f5e9', accent: '#4caf50', text: '#2e7d32' },
  concerned: { bg: '#fff8e1', accent: '#ff9800', text: '#e65100' },
  encouraging: { bg: '#e3f2fd', accent: '#2196f3', text: '#1565c0' },
  neutral: { bg: '#f5f5f5', accent: '#9e9e9e', text: '#616161' },
};

const DEFAULT_PERSONALITY: PersonalityTraits = {
  encouragementFrequency: 0.8,
  severityTone: 0.3,
  formality: 0.2,
  brevity: 0.3,
};

const TRAIT_KEYS: { key: keyof PersonalityTraits; i18nKey: string; color: string }[] = [
  { key: 'encouragementFrequency', i18nKey: 'buddy.trait_encouragement', color: '#4caf50' },
  { key: 'severityTone', i18nKey: 'buddy.trait_severity', color: '#ff9800' },
  { key: 'formality', i18nKey: 'buddy.trait_formality', color: '#2196f3' },
  { key: 'brevity', i18nKey: 'buddy.trait_brevity', color: '#9c27b0' },
];

// ── Component ──────────────────────────────────────────────────

export default function BuddyWidget({ pendingCount }: BuddyWidgetProps) {
  const { t } = useI18n();
  const [mood, setMood] = useState<BuddyMood>('neutral');
  const [greeting, setGreeting] = useState<string | null>(null);
  const [comment, setComment] = useState<string | null>(null);
  const [level, setLevel] = useState<BuddyLevel>('full');
  const [personality, setPersonality] = useState<PersonalityTraits>(DEFAULT_PERSONALITY);
  const [showPersonality, setShowPersonality] = useState(false);
  const [animating, setAnimating] = useState(false);

  const prevMoodRef = useRef<BuddyMood>(mood);
  const mountedRef = useRef(true);

  // ── Fetch greeting on mount ────────────────────────────────────

  useEffect(() => {
    loadGreeting();
    return () => { mountedRef.current = false; };
  }, []);

  // ── Fetch comment when pendingCount changes ────────────────────

  useEffect(() => {
    loadComment();
  }, [pendingCount]);

  // ── Listen for dream.buddy_adjustments events ──────────────────

  useEffect(() => {
    const unsub = onSidecarEvent((eventStr: string) => {
      if (!mountedRef.current) {return;}
      try {
        const event = JSON.parse(eventStr);
        if (event.method === 'dream.buddy_adjustments' && event.params?.adjustments) {
          const adj = event.params.adjustments;
          if (adj.moodBias && MOOD_COLORS[adj.moodBias as BuddyMood]) {
            setMood(adj.moodBias as BuddyMood);
          }
          setPersonality((prev) => ({
            encouragementFrequency: adj.encouragementFrequency ?? prev.encouragementFrequency,
            severityTone: adj.severityTone ?? prev.severityTone,
            formality: adj.formality ?? prev.formality,
            brevity: adj.brevity ?? prev.brevity,
          }));
        }
      } catch {
        // Ignore parse errors for non-relevant events
      }
    });
    return () => unsub();
  }, []);

  // ── Mood change animation ──────────────────────────────────────

  useEffect(() => {
    if (prevMoodRef.current !== mood) {
      setAnimating(true);
      prevMoodRef.current = mood;
      const timer = setTimeout(() => {
        if (mountedRef.current) {setAnimating(false);}
      }, 700);
      return () => clearTimeout(timer);
    }
  }, [mood]);

  // ── Data Loaders ───────────────────────────────────────────────

  async function loadGreeting() {
    try {
      const result = await callCapability('buddy.greet', {}) as {
        greeting?: string;
        mood?: BuddyMood;
        level?: BuddyLevel;
        personality?: PersonalityTraits;
      };
      if (result.greeting !== undefined) {setGreeting(result.greeting);}
      if (result.mood) {setMood(result.mood);}
      if (result.level) {setLevel(result.level);}
      if (result.personality) {setPersonality(result.personality);}
    } catch (err) {
      console.error('[BuddyWidget] Failed to load greeting:', err);
    }
  }

  async function loadComment() {
    try {
      const result = await callCapability('buddy.comment', { taskCount: pendingCount }) as {
        comment?: string;
        mood?: BuddyMood;
      };
      if (result.comment !== undefined) {setComment(result.comment);}
      if (result.mood) {setMood(result.mood);}
    } catch (err) {
      console.error('[BuddyWidget] Failed to load comment:', err);
    }
  }

  // ── Early return if buddy is off ───────────────────────────────

  if (level === 'off') {return null;}

  const colors = MOOD_COLORS[mood] || MOOD_COLORS.neutral;
  const emoji = MOOD_EMOJI[mood] || MOOD_EMOJI.neutral;
  const moodLabel = t('buddy.mood_' + mood);

  return (
    <div
      className="card"
      style={{
        marginTop: 16,
        background: colors.bg,
        borderLeft: `4px solid ${colors.accent}`,
        transition: 'background 0.4s ease, border-color 0.4s ease, transform 0.4s ease',
        transform: animating ? 'scale(1.015)' : 'scale(1)',
      }}
      role="status"
      aria-live="polite"
    >
      {/* Greeting row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: comment ? 10 : 0 }}>
        <span
          style={{
            fontSize: 28,
            lineHeight: 1,
            display: 'inline-block',
            transition: 'transform 0.35s ease',
            transform: animating ? 'scale(1.25)' : 'scale(1)',
          }}
          aria-label={moodLabel}
          title={moodLabel}
        >
          {emoji}
        </span>
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: 15, fontWeight: 500, color: colors.text }}>
            {greeting || '...'}
          </span>
        </div>
        {/* Mood badge */}
        <span
          style={{
            fontSize: 10,
            padding: '2px 8px',
            borderRadius: 10,
            background: colors.accent + '25',
            color: colors.text,
            opacity: 0.7,
            fontWeight: 500,
          }}
        >
          {moodLabel}
        </span>
      </div>

      {/* Schedule comment */}
      {comment && (
        <div
          style={{
            fontSize: 13,
            color: colors.text,
            opacity: 0.85,
            marginLeft: 38,
            lineHeight: 1.5,
          }}
        >
          {comment}
        </div>
      )}

      {/* Personality traits (expandable, full mode only) */}
      {level === 'full' && (
        <div style={{ marginTop: 10 }}>
          <button
            className="btn btn-secondary"
            style={{
              fontSize: 11,
              padding: '2px 10px',
              opacity: 0.6,
              cursor: 'pointer',
              background: 'transparent',
              border: `1px solid ${colors.accent}40`,
              color: colors.text,
              borderRadius: 4,
            }}
            onClick={() => setShowPersonality(!showPersonality)}
            aria-expanded={showPersonality}
          >
            {showPersonality ? t('buddy.personality_toggle_open') : t('buddy.personality_toggle_closed')}
          </button>

          {showPersonality && (
            <div
              style={{
                marginTop: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                animation: 'fadeIn 0.2s ease',
              }}
            >
              {TRAIT_KEYS.map((trait) => {
                const value = personality[trait.key];
                return (
                  <div key={trait.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        fontSize: 11,
                        color: colors.text,
                        minWidth: 56,
                        opacity: 0.7,
                      }}
                    >
                      {t(trait.i18nKey)}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: 6,
                        background: `${colors.accent}20`,
                        borderRadius: 3,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.round(value * 100)}%`,
                          height: '100%',
                          background: trait.color,
                          borderRadius: 3,
                          transition: 'width 0.6s ease',
                        }}
                      />
                    </div>
                    <span
                      style={{
                        fontSize: 10,
                        color: colors.text,
                        opacity: 0.5,
                        minWidth: 28,
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {Math.round(value * 100)}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
