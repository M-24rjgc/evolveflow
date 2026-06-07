import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useI18n } from '../lib/i18n';

// ── Types ────────────────────────────────────────────────────────

interface HelpItem {
  title: string;
  content: string;
}

interface HelpSection {
  title: string;
  items: HelpItem[];
}

// ── HelpPanel Component ──────────────────────────────────────────

interface HelpPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function HelpPanel({ isOpen, onClose }: HelpPanelProps) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus the search input when panel opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Reset filters when panel closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setActiveSection(null);
    }
  }, [isOpen]);

  // Define all sections
  const sections: HelpSection[] = useMemo(() => [
    {
      title: t('help.section_getting_started'),
      items: [
        { title: t('help.gs_0_title'), content: t('help.gs_0_content') },
        { title: t('help.gs_1_title'), content: t('help.gs_1_content') },
        { title: t('help.gs_2_title'), content: t('help.gs_2_content') },
        { title: t('help.gs_3_title'), content: t('help.gs_3_content') },
      ],
    },
    {
      title: t('help.section_shortcuts'),
      items: [
        { title: t('help.sc_0_title'), content: t('help.sc_0_content') },
        { title: t('help.sc_1_title'), content: t('help.sc_1_content') },
        { title: t('help.sc_2_title'), content: t('help.sc_2_content') },
        { title: t('help.sc_3_title'), content: t('help.sc_3_content') },
        { title: t('help.sc_4_title'), content: t('help.sc_4_content') },
        { title: t('help.sc_5_title'), content: t('help.sc_5_content') },
      ],
    },
    {
      title: t('help.section_ai_tips'),
      items: [
        { title: t('help.ai_0_title'), content: t('help.ai_0_content') },
        { title: t('help.ai_1_title'), content: t('help.ai_1_content') },
        { title: t('help.ai_2_title'), content: t('help.ai_2_content') },
        { title: t('help.ai_3_title'), content: t('help.ai_3_content') },
        { title: t('help.ai_4_title'), content: t('help.ai_4_content') },
      ],
    },
    {
      title: t('help.section_faq'),
      items: [
        { title: t('help.faq_0_title'), content: t('help.faq_0_content') },
        { title: t('help.faq_1_title'), content: t('help.faq_1_content') },
        { title: t('help.faq_2_title'), content: t('help.faq_2_content') },
        { title: t('help.faq_3_title'), content: t('help.faq_3_content') },
        { title: t('help.faq_4_title'), content: t('help.faq_4_content') },
        { title: t('help.faq_5_title'), content: t('help.faq_5_content') },
      ],
    },
  ], [t]);

  // Filter sections/items based on search query and active section filter
  const filteredSections = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();

    return sections
      .filter((section) => {
        if (activeSection !== null && section.title !== activeSection) {return false;}
        if (!query) {return true;}
        return section.items.some(
          (item) =>
            item.title.toLowerCase().includes(query) ||
            item.content.toLowerCase().includes(query),
        );
      })
      .map((section) => {
        if (!query) {return section;}
        return {
          ...section,
          items: section.items.filter(
            (item) =>
              item.title.toLowerCase().includes(query) ||
              item.content.toLowerCase().includes(query),
          ),
        };
      });
  }, [searchQuery, activeSection, sections]);

  const hasResults = filteredSections.some((s) => s.items.length > 0);

  // ── Render ─────────────────────────────────────────────────────

  if (!isOpen) {return null;}

  return (
    <div
      className="help-panel-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 5000,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {onClose();}
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('help.title')}
    >
      <div
        className="help-panel"
        style={{
          width: 420,
          maxWidth: '100vw',
          height: '100vh',
          background: '#ffffff',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'helpPanelSlideIn 0.25s ease-out',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #e9ecef',
            flexShrink: 0,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#2c3e50' }}>
            {t('help.title')}
          </h2>
          <button
            className="btn btn-secondary"
            onClick={onClose}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              background: 'none',
              border: '1px solid #e9ecef',
              borderRadius: 6,
              cursor: 'pointer',
              color: '#888',
            }}
            aria-label={t('help.close_panel')}
          >
            ✕
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
          <input
            ref={searchInputRef}
            type="text"
            placeholder={t('help.search_placeholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label={t('help.search_placeholder')}
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid #dee2e6',
              fontSize: 14,
              outline: 'none',
              transition: 'border-color 0.15s',
            }}
          />

          {/* Section filter chips */}
          <div
            style={{
              display: 'flex',
              gap: 6,
              marginTop: 10,
              flexWrap: 'wrap',
            }}
            role="group"
            aria-label={t('help.all_sections')}
          >
            <button
              className={`btn ${activeSection === null ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: 11, padding: '4px 10px' }}
              onClick={() => setActiveSection(null)}
            >
              {t('help.all_sections')}
            </button>
            {sections.map((section) => (
              <button
                key={section.title}
                className={`btn ${activeSection === section.title ? 'btn-primary' : 'btn-secondary'}`}
                style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={() =>
                  setActiveSection(
                    activeSection === section.title ? null : section.title,
                  )
                }
              >
                {section.title}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 20px',
          }}
        >
          {!hasResults ? (
            <div
              style={{
                textAlign: 'center',
                padding: 32,
                color: '#888',
              }}
            >
              <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
              <p>{t('help.no_results')}</p>
            </div>
          ) : (
            filteredSections.map((section) =>
              section.items.length > 0 ? (
                <div key={section.title} style={{ marginBottom: 24 }}>
                  <h3
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: '#4a6fa5',
                      marginBottom: 12,
                      paddingBottom: 6,
                      borderBottom: '2px solid #e9ecef',
                    }}
                  >
                    {section.title}
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {section.items.map((item, idx) => (
                      <details
                        key={idx}
                        style={{
                          background: '#f8f9fa',
                          borderRadius: 8,
                          padding: '8px 12px',
                          cursor: 'pointer',
                        }}
                      >
                        <summary
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: '#333',
                            outline: 'none',
                          }}
                        >
                          {item.title}
                        </summary>
                        <p
                          style={{
                            margin: '8px 0 0',
                            fontSize: 13,
                            lineHeight: 1.6,
                            color: '#555',
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {item.content}
                        </p>
                      </details>
                    ))}
                  </div>
                </div>
              ) : null,
            )
          )}
        </div>

        {/* Panel slide-in animation */}
        <style>{`
          @keyframes helpPanelSlideIn {
            from { transform: translateX(100%); }
            to { transform: translateX(0); }
          }
        `}</style>
      </div>
    </div>
  );
}
