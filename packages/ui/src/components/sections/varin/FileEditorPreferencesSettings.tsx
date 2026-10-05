import React from 'react';

import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type {
  FileEditorAccessibilitySupport,
  FileEditorLineNumbers,
  FileEditorProfileToggle,
  FileEditorWhitespace,
} from '@/lib/file-editor-settings';
import { useUIStore } from '@/stores/useUIStore';

const PROFILE_TOGGLE_VALUES: readonly FileEditorProfileToggle[] = ['profile', 'on', 'off'];
const WHITESPACE_VALUES: readonly FileEditorWhitespace[] = ['none', 'selection', 'boundary', 'trailing', 'all'];

export const FileEditorPreferencesSettings: React.FC = () => {
  const { t } = useI18n();
  const settings = useUIStore((state) => state.fileEditorSettings);
  const update = useUIStore((state) => state.updateFileEditorSettings);
  const reset = useUIStore((state) => state.resetFileEditorSettings);

  const profileToggleLabel = (value: FileEditorProfileToggle): string => {
    if (value === 'profile') return t('settings.varin.editor.option.followProfile');
    return value === 'on'
      ? t('settings.varin.editor.option.on')
      : t('settings.varin.editor.option.off');
  };

  return (
    <SettingsSection
      title={t('settings.varin.editor.section.title')}
      description={t('settings.varin.editor.section.description')}
      settingsItem="appearance.file-editor"
      headerAction={(
        <Button type="button" variant="ghost" size="sm" onClick={reset}>
          {t('settings.common.actions.reset')}
        </Button>
      )}
      contentClassName="space-y-6"
    >
      <SettingsTwoColumn>
        <SettingsStackedField label={t('settings.varin.editor.field.wordWrap')}>
          <Select value={settings.wordWrap} onValueChange={(value) => update({ wordWrap: value as FileEditorProfileToggle })}>
            <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROFILE_TOGGLE_VALUES.map((value) => <SelectItem key={value} value={value}>{profileToggleLabel(value)}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsStackedField>

        <SettingsStackedField label={t('settings.varin.editor.field.minimap')}>
          <Select value={settings.minimap} onValueChange={(value) => update({ minimap: value as FileEditorProfileToggle })}>
            <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROFILE_TOGGLE_VALUES.map((value) => <SelectItem key={value} value={value}>{profileToggleLabel(value)}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsStackedField>

        <SettingsStackedField label={t('settings.varin.editor.field.stickyScroll')}>
          <Select value={settings.stickyScroll} onValueChange={(value) => update({ stickyScroll: value as FileEditorProfileToggle })}>
            <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROFILE_TOGGLE_VALUES.map((value) => <SelectItem key={value} value={value}>{profileToggleLabel(value)}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsStackedField>

        <SettingsStackedField label={t('settings.varin.editor.field.lineNumbers')}>
          <Select value={settings.lineNumbers} onValueChange={(value) => update({ lineNumbers: value as FileEditorLineNumbers })}>
            <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="profile">{t('settings.varin.editor.option.followProfile')}</SelectItem>
              <SelectItem value="on">{t('settings.varin.editor.option.on')}</SelectItem>
              <SelectItem value="off">{t('settings.varin.editor.option.off')}</SelectItem>
              <SelectItem value="relative">{t('settings.varin.editor.option.relative')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsStackedField>

        <SettingsStackedField label={t('settings.varin.editor.field.whitespace')}>
          <Select value={settings.renderWhitespace} onValueChange={(value) => update({ renderWhitespace: value as FileEditorWhitespace })}>
            <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WHITESPACE_VALUES.map((value) => (
                <SelectItem key={value} value={value}>{t(`settings.varin.editor.option.whitespace.${value}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsStackedField>

        <SettingsStackedField label={t('settings.varin.editor.field.accessibility')}>
          <Select value={settings.accessibilitySupport} onValueChange={(value) => update({ accessibilitySupport: value as FileEditorAccessibilitySupport })}>
            <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('settings.varin.editor.option.auto')}</SelectItem>
              <SelectItem value="on">{t('settings.varin.editor.option.on')}</SelectItem>
              <SelectItem value="off">{t('settings.varin.editor.option.off')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsStackedField>

      </SettingsTwoColumn>

      <SettingsTwoColumn>
        <SettingsControlGroup title={t('settings.varin.editor.group.indentation')} contentClassName="space-y-3">
          <SettingsStackedField
            label={t('settings.varin.editor.field.tabSize')}
            description={t('settings.varin.editor.field.tabSize.description')}
            controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
          >
            <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
              <NumberInput
                value={settings.tabSize}
                onValueChange={(tabSize) => update({ tabSize })}
                min={1}
                step={1}
              />
            </div>
          </SettingsStackedField>
          <SettingsCheckboxRow
            checked={settings.detectIndentation}
            onChange={(detectIndentation) => update({ detectIndentation })}
            label={t('settings.varin.editor.field.detectIndentation')}
            ariaLabel={t('settings.varin.editor.field.detectIndentation')}
          />
          <SettingsCheckboxRow
            checked={settings.insertSpaces}
            onChange={(insertSpaces) => update({ insertSpaces })}
            label={t('settings.varin.editor.field.insertSpaces')}
            ariaLabel={t('settings.varin.editor.field.insertSpaces')}
          />
        </SettingsControlGroup>

        <SettingsControlGroup title={t('settings.varin.editor.group.behavior')} contentClassName="space-y-1.5">
          <SettingsCheckboxRow
            checked={settings.folding}
            onChange={(folding) => update({ folding })}
            label={t('settings.varin.editor.field.folding')}
            ariaLabel={t('settings.varin.editor.field.folding')}
          />
          <SettingsCheckboxRow
            checked={settings.autoClosingBrackets && settings.autoClosingQuotes && settings.autoSurround}
            onChange={(enabled) => update({ autoClosingBrackets: enabled, autoClosingQuotes: enabled, autoSurround: enabled })}
            label={t('settings.varin.editor.field.autoClosing')}
            ariaLabel={t('settings.varin.editor.field.autoClosing')}
          />
          <SettingsCheckboxRow
            checked={settings.fontLigatures}
            onChange={(fontLigatures) => update({ fontLigatures })}
            label={t('settings.varin.editor.field.fontLigatures')}
            ariaLabel={t('settings.varin.editor.field.fontLigatures')}
          />
          <SettingsCheckboxRow
            checked={settings.smoothScrolling}
            onChange={(smoothScrolling) => update({ smoothScrolling })}
            label={t('settings.varin.editor.field.smoothScrolling')}
            ariaLabel={t('settings.varin.editor.field.smoothScrolling')}
          />
          <SettingsCheckboxRow
            checked={settings.formatOnType}
            onChange={(formatOnType) => update({ formatOnType })}
            label={t('settings.varin.editor.field.formatOnType')}
            ariaLabel={t('settings.varin.editor.field.formatOnType')}
          />
          <SettingsCheckboxRow
            checked={settings.formatOnSave}
            onChange={(formatOnSave) => update({ formatOnSave })}
            label={t('settings.varin.editor.field.formatOnSave')}
            ariaLabel={t('settings.varin.editor.field.formatOnSave')}
          />
        </SettingsControlGroup>
      </SettingsTwoColumn>
    </SettingsSection>
  );
};
