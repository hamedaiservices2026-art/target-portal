import type { PackGroup } from '../../shared/types';
import { t, type TextKey } from '../i18n';

export type GroupTab = 'all' | PackGroup;

const TABS: { id: GroupTab; label: TextKey }[] = [
  { id: 'all', label: 'dsTabAll' },
  { id: 'CSD', label: 'dsTabCSD' },
  { id: 'Water', label: 'dsTabWater' },
  { id: 'LRB-Others', label: 'dsTabLRB' },
];

/** All packs / CSD / Water / LRB-Others. */
export function GroupTabs({ value, onChange }: { value: GroupTab; onChange: (g: GroupTab) => void }) {
  return (
    <div class="toolbar" role="group" aria-label={t('dsGroupsLabel')}>
      {TABS.map((tab) => (
        <button
          type="button" key={tab.id} class={`tab${value === tab.id ? ' on' : ''}`}
          aria-pressed={value === tab.id} onClick={() => onChange(tab.id)}
        >
          {t(tab.label)}
        </button>
      ))}
    </div>
  );
}
