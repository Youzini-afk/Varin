import React from 'react';
import { ChatSettingsPreview } from './ChatSettingsPreview';
import { SettingsReadingPreview } from './SettingsReadingPreview';
import { VarinVisualSettings } from './VarinVisualSettings';
import { ChatSettings } from './ChatSettings';
import { AboutSettings } from './AboutSettings';
import { SessionRetentionSettings } from './SessionRetentionSettings';
import { PasskeySettings } from './PasskeySettings';
import { DefaultsSettings } from './DefaultsSettings';
import { GitSettings } from './GitSettings';
import { NotificationSettings } from './NotificationSettings';
import { GitHubSettings } from './GitHubSettings';
import { VoiceSettings } from './VoiceSettings';
import { TunnelSettings } from './TunnelSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { SettingsPageLink } from '@/components/sections/shared/SettingsPageLink';
import { RecoverySettings } from './RecoverySettings';
import type { VarinSettingsSection } from './types';

const useRuntimeEndpointEpoch = (): number => {
    const [epoch, setEpoch] = React.useState(0);

    React.useEffect(() => {
        return subscribeRuntimeEndpointChanged(() => setEpoch((current) => current + 1));
    }, []);

    return epoch;
};

interface VarinSettingsPageProps {
    /** Which section to display. If undefined, shows all sections (mobile/legacy behavior) */
    section?: VarinSettingsSection;
}

export const VarinSettingsPage: React.FC<VarinSettingsPageProps> = ({ section }) => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
    const showAbout = isMobile && isWebRuntime();
    void runtimeEndpointEpoch;
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();

    // If no section specified, show all (mobile/legacy behavior)
    if (!section) {
        return (
            <SettingsPageLayout showSaveStatus className="varin-settings-page-body space-y-3 sm:space-y-6">
                <VarinVisualSettings />
                <ChatSettings />
                <DefaultsSettings />
                {showDesktopNetworkSettings && <DesktopNetworkSettings section="general" />}
                <SessionRetentionSettings />
                <RecoverySettings />
                {isWebRuntime() && !isDesktopShell() && !isCapacitorApp() && <PasskeySettings />}
                {showAbout && <AboutSettings />}
            </SettingsPageLayout>
        );
    }

    // Show specific section content
    const renderSectionContent = () => {
        switch (section) {
            case 'general':
                return <GeneralSectionContent />;
            case 'visual':
                return <VisualSectionContent />;
            case 'chat':
                return <ChatSectionContent />;
            case 'editor':
                return <EditorSectionContent />;
            case 'terminal':
                return <TerminalSectionContent />;
            case 'sessions':
                return <SessionsSectionContent />;
            case 'shortcuts':
                return <ShortcutsSectionContent />;
            case 'git':
                return <GitSectionContent />;
            case 'github':
                return <GitHubSectionContent />;
            case 'notifications':
                return <NotificationSectionContent />;
            case 'voice':
                return <VoiceSectionContent />;
            case 'tunnel':
                return <TunnelSectionContent />;
            case 'about':
                return <AboutSettings />;
            default:
                return null;
        }
    };

    const pageTitle = {
        general: t('settings.page.general.title'),
        visual: t('settings.page.appearance.title'),
        chat: t('settings.page.chat.title'),
        editor: t('settings.page.editor.title'),
        terminal: t('settings.page.terminal.title'),
        sessions: t('settings.page.sessions.title'),
        shortcuts: t('settings.page.shortcuts.title'),
        git: t('settings.page.git.title'),
        github: t('settings.page.git.title'),
        notifications: t('settings.page.notifications.title'),
        voice: t('settings.page.voice.title'),
        tunnel: t('settings.page.tunnel.title'),
        about: t('settings.page.about.title'),
    }[section];

    const pageDescription = {
        general: t('settings.page.general.description'),
        visual: t('settings.page.appearance.description'),
        chat: t('settings.page.chat.description'),
        editor: t('settings.page.editor.description'),
        terminal: t('settings.page.terminal.description'),
        sessions: t('settings.page.sessions.description'),
        shortcuts: t('settings.page.shortcuts.description'),
        git: undefined,
        github: undefined,
        notifications: t('settings.page.notifications.description'),
        voice: t('settings.page.voice.description'),
        tunnel: t('settings.page.tunnel.description'),
        about: undefined,
    }[section];

    return (
        <SettingsPageLayout
            title={pageTitle}
            description={pageDescription}
            showSaveStatus
            className={section === 'chat' ? 'varin-settings-page-body settings-chat-page' : ['visual', 'editor', 'terminal', 'notifications'].includes(section) ? 'varin-settings-page-body settings-wide-page' : 'varin-settings-page-body'}
        >
            {renderSectionContent()}
        </SettingsPageLayout>
    );
};

const ShortcutsSectionContent: React.FC = () => {
    return <KeyboardShortcutsSettings />;
};

// General owns startup and language/region. Security and editor preferences have dedicated pages.
const GeneralSectionContent: React.FC = () => {
    const { t } = useI18n();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
    void runtimeEndpointEpoch;
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();
    return (
        <>
            {showDesktopNetworkSettings && <DesktopNetworkSettings section="general" />}
            <SettingsPageLink page="access">{t('settings.page.access.title')}</SettingsPageLink>
            {showDesktopNetworkSettings && <SettingsPageLink page="companion">{t('companion.library.settings')}</SettingsPageLink>}
            <VarinVisualSettings visibleSettings={['locale', 'timeFormat', 'weekStart', 'pwaInstallName', 'pwaOrientation', 'mobileKeyboardMode']} />

        </>
    );
};

// Visual section: Theme Mode, Font Size, Spacing, Input Bar Offset (mobile), Nav Rail
const VisualSectionContent: React.FC = () => {
    const [scene, setScene] = React.useState<import('./ChatSettingsPreview').ChatPreviewScene>('conversation');
    return <div className="settings-preview-layout"><div className="@container min-w-0"><VarinVisualSettings visibleSettings={[
        'theme',
        'windowControlsPosition',
        'motion',
        'fontSize',
        'spacing',
        'inputBarOffset',
    ]} /></div><div className="settings-preview-pane"><ChatSettingsPreview scene={scene} onSceneChange={setScene} /></div></div>;
};

const ChatSectionContent: React.FC = () => <ChatSettings />;

const EditorSectionContent: React.FC = () => <div className="settings-preview-layout"><div className="@container min-w-0"><VarinVisualSettings visibleSettings={[
    'codeFont', 'editorFontSize', 'fileEditorKeymap', 'fileEditorPreferences',
    'autoSaveEnabled', 'expandedEditorToolbar',
]} /></div><SettingsReadingPreview kind="editor" /></div>;

const TerminalSectionContent: React.FC = () => {
    const { t } = useI18n();
    return <div className="settings-preview-layout"><div className="@container min-w-0">
        <SettingsPageLink page="editor" description={t('settings.page.editor.title')}>{t('settings.varin.visual.field.codeFont')}</SettingsPageLink>
        <VarinVisualSettings visibleSettings={['terminalFontSize', 'terminalQuickKeys', 'terminalShell', 'terminalLoginShell']} />
    </div><SettingsReadingPreview kind="terminal" /></div>;
};

// Defaults retain their Host/project owner; client deletion confirmation is separate.
const SessionsSectionContent: React.FC = () => {
    return (
        <>
            <DefaultsSettings />
        </>
    );
};

// Git section: Commit message model, Worktree settings
const GitSectionContent: React.FC = () => {
    return <GitSettings />;
};

// GitHub section: Connect account for PR/issue workflows
const GitHubSectionContent: React.FC = () => {
    return <GitHubSettings />;
};

// Notifications section: Native browser notifications
const NotificationSectionContent: React.FC = () => {
    return <NotificationSettings />;
};

// Voice section: Language selection and continuous mode
const VoiceSectionContent: React.FC = () => {
    return <VoiceSettings />;
};

const TunnelSectionContent: React.FC = () => {
    return <TunnelSettings />;
};
