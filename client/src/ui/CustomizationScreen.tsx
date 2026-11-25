/**
 * Character customization: live <CharacterPreview>, option chips/swatches driven
 * entirely by the shared catalogs (APPEARANCE_CATALOG / ACCESSORY_CATALOG),
 * randomize, optional display-name field. Used in onboarding and in-game
 * (Settings → Edit character), where the caller sends C2S.updateProfile.
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  ACCESSORY_CATALOG,
  APPEARANCE_CATALOG,
  CONFIG,
  randomAppearance,
  randomDisplayName,
  validateDisplayName,
  type AccessorySlot,
  type AnimState,
  type Appearance,
  type AppearanceSlot,
  type CatalogOption,
  type ColorOption,
  type DisplayNameError,
} from '@elsewhere/shared';
import { CharacterPreview } from '../characters/index.js';
import { Icon } from './icons.js';

export interface CustomizationScreenProps {
  initial: Appearance;
  onSave(appearance: Appearance, name?: string): void;
  onCancel(): void;
  /** Show the display-name field (in-game edit). */
  initialName?: string;
  showName?: boolean;
  saveLabel?: string;
  cancelLabel?: string;
  /** 'screen' = full-screen onboarding layout; 'panel' = inside a sheet. */
  layout?: 'screen' | 'panel';
  busy?: boolean;
  error?: string | null;
}

const SLOT_LABEL: Record<AppearanceSlot | AccessorySlot, string> = {
  body: 'Shape',
  skin: 'Skin',
  hairStyle: 'Hairstyle',
  hairColor: 'Hair colour',
  face: 'Face',
  shirtStyle: 'Top',
  shirtColor: 'Top colour',
  pantsStyle: 'Bottoms',
  pantsColor: 'Bottoms colour',
  shoeStyle: 'Shoes',
  shoeColor: 'Shoe colour',
  hat: 'Hat',
  eyewear: 'Eyewear',
  neck: 'Neck',
  back: 'On your back',
};

type Group = { id: string; label: string; slots: (AppearanceSlot | AccessorySlot)[] };
const GROUPS: readonly Group[] = [
  { id: 'body', label: 'Body', slots: ['body', 'skin'] },
  { id: 'hair', label: 'Hair', slots: ['hairStyle', 'hairColor'] },
  { id: 'face', label: 'Face', slots: ['face'] },
  { id: 'outfit', label: 'Outfit', slots: ['shirtStyle', 'shirtColor', 'pantsStyle', 'pantsColor', 'shoeStyle', 'shoeColor'] },
  { id: 'extras', label: 'Extras', slots: ['hat', 'eyewear', 'neck', 'back'] },
];

export const NAME_ERRORS: Record<DisplayNameError, string> = {
  too_short: `At least ${CONFIG.profile.displayNameMin} characters.`,
  too_long: `At most ${CONFIG.profile.displayNameMax} characters.`,
  invalid_characters: 'Letters, numbers, spaces and . _ - ’ only, starting with a letter or number.',
  reserved: 'That name is reserved. Try another.',
};

function isAccessory(slot: string): slot is AccessorySlot {
  return slot in ACCESSORY_CATALOG;
}

function optionsFor(slot: AppearanceSlot | AccessorySlot): readonly (CatalogOption | ColorOption)[] {
  return isAccessory(slot) ? ACCESSORY_CATALOG[slot] : APPEARANCE_CATALOG[slot];
}

function valueOf(a: Appearance, slot: AppearanceSlot | AccessorySlot): string {
  return isAccessory(slot) ? a.accessories[slot] : a[slot];
}

function withValue(a: Appearance, slot: AppearanceSlot | AccessorySlot, id: string): Appearance {
  if (isAccessory(slot)) return { ...a, accessories: { ...a.accessories, [slot]: id } };
  return { ...a, [slot]: id } as Appearance;
}

function SlotPicker({ slot, appearance, onPick }: { slot: AppearanceSlot | AccessorySlot; appearance: Appearance; onPick(id: string): void }) {
  const opts = optionsFor(slot);
  const current = valueOf(appearance, slot);
  const isColor = opts.length > 0 && 'hex' in opts[0]!;
  const id = useId();
  const currentLabel = opts.find((o) => o.id === current)?.label;
  return (
    <fieldset className="slot">
      <legend className="slot__legend" id={id}>
        <span>{SLOT_LABEL[slot]}</span>
        {isColor && currentLabel ? <span className="slot__current">{currentLabel}</span> : null}
      </legend>
      <div className={isColor ? 'swatches' : 'chips'} role="radiogroup" aria-labelledby={id}>
        {opts.map((o) =>
          'hex' in o ? (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={current === o.id}
              aria-label={o.label}
              title={o.label}
              className={`swatch${current === o.id ? ' is-on' : ''}`}
              style={{ '--sw': o.hex } as React.CSSProperties}
              onClick={() => onPick(o.id)}
            />
          ) : (
            <button key={o.id} type="button" role="radio" aria-checked={current === o.id} className={`chip${current === o.id ? ' is-on' : ''}`} onClick={() => onPick(o.id)}>
              {o.label}
            </button>
          ),
        )}
      </div>
    </fieldset>
  );
}

export function CustomizationScreen({
  initial,
  onSave,
  onCancel,
  initialName,
  showName = false,
  saveLabel = 'Save',
  cancelLabel = 'Cancel',
  layout = 'screen',
  busy = false,
  error = null,
}: CustomizationScreenProps) {
  const [appearance, setAppearance] = useState<Appearance>(initial);
  const [group, setGroup] = useState(GROUPS[0]!.id);
  const [name, setName] = useState(initialName ?? '');
  const [touched, setTouched] = useState(false);
  const [anim, setAnim] = useState<AnimState>('idle');
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameId = useId();

  useEffect(() => () => {
    if (animTimer.current) clearTimeout(animTimer.current);
  }, []);

  const flourish = (a: AnimState, ms: number) => {
    setAnim(a);
    if (animTimer.current) clearTimeout(animTimer.current);
    animTimer.current = setTimeout(() => setAnim('idle'), ms);
  };

  const nameCheck = validateDisplayName(name);
  const nameError = showName && touched && !nameCheck.ok ? NAME_ERRORS[nameCheck.reason] : null;
  const canSave = !busy && (!showName || nameCheck.ok);

  const randomize = () => {
    setAppearance(randomAppearance());
    flourish('wave', CONFIG.emotes.waveDurationMs);
  };

  const save = () => {
    setTouched(true);
    if (!canSave) return;
    onSave(appearance, showName && nameCheck.ok ? nameCheck.name : undefined);
  };

  const active = GROUPS.find((g) => g.id === group) ?? GROUPS[0]!;

  return (
    <div className={`customize customize--${layout}`} data-testid="customize">
      <div className="customize__stage">
        <CharacterPreview appearance={appearance} anim={anim} spin={0} className="customize__preview" />
        <span className="customize__hint" aria-hidden="true">Drag to turn</span>
        <button type="button" className="btn btn--ghost btn--sm customize__random" onClick={randomize} data-testid="randomize">
          <Icon name="dice" size={18} /> Surprise me
        </button>
      </div>

      <div className="customize__panel">
        {showName ? (
          <div className="field">
            <label htmlFor={nameId} className="field__label">
              Display name
            </label>
            <div className="field__row">
              <input
                id={nameId}
                className={`input${nameError ? ' is-invalid' : ''}`}
                value={name}
                maxLength={CONFIG.profile.displayNameMax + 4}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!nameError}
                aria-describedby={nameError ? `${nameId}-e` : undefined}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched(true)}
              />
              <button type="button" className="icon-btn" aria-label="Suggest a name" title="Suggest a name" onClick={() => setName(randomDisplayName())}>
                <Icon name="dice" size={20} />
              </button>
            </div>
            {nameError ? (
              <p className="field__error" id={`${nameId}-e`} role="alert">
                {nameError}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="tabs" role="tablist" aria-label="Appearance">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              id={`cz-tab-${g.id}`}
              aria-selected={g.id === group}
              aria-controls="cz-tabpanel"
              className={g.id === group ? 'is-on' : ''}
              onClick={() => setGroup(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>

        <div className="customize__options" role="tabpanel" id="cz-tabpanel" aria-labelledby={`cz-tab-${active.id}`}>
          {active.slots.map((slot) => (
            <SlotPicker key={slot} slot={slot} appearance={appearance} onPick={(id) => setAppearance((a) => withValue(a, slot, id))} />
          ))}
        </div>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="customize__actions">
          <button type="button" className="btn btn--quiet" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={!canSave} data-testid="customize-save">
            {busy ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
