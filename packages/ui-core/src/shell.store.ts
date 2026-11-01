import { signal, type ReadonlySignal } from '@preact/signals-core';
import type { AuthResult } from './auth-session.ts';
import {
  authErrorText,
  validateConfirmForm,
  validateEmailForm,
  validateInviteForm,
} from './auth-forms.ts';
import { safeReturnTo } from './access-ui.ts';
import type { SessionUserStore } from './session-user.store.ts';
import type { Preferences } from './ports.ts';
import type { FormIssue } from './index.ts';

// Спека 014, 4.12 (REQ-014-5…8, REQ-014-16): стор каркаса — вход, регистрация, подтверждение, приглашение, тема.

export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_KEY = 'swag.theme';
const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

export interface ShellForm {
  busy: boolean;
  error: string | null;
  issues: FormIssue[];
  sent: boolean;
}

export interface ShellStore {
  readonly form: ReadonlySignal<ShellForm>;
  readonly theme: ReadonlySignal<ThemeMode>;
  readonly sectionUnavailable: ReadonlySignal<boolean>;
  login(email: string, password: string, returnTo: string | null): Promise<string | null>;
  register(email: string): Promise<void>;
  confirmRegistration(input: Parameters<typeof validateConfirmForm>[0]): Promise<string | null>;
  acceptInvitation(input: Parameters<typeof validateInviteForm>[0]): Promise<string | null>;
  logout(): Promise<void>;
  setTheme(mode: ThemeMode): void;
  setSectionUnavailable(flag: boolean): void;
  resetForm(): void;
}

const initialForm = (): ShellForm => ({ busy: false, error: null, issues: [], sent: false });

export function createShellStore({
  session,
  preferences,
}: {
  session: Pick<
    SessionUserStore,
    'login' | 'register' | 'confirmRegistration' | 'acceptInvitation' | 'logout'
  >;
  preferences: Preferences;
}): ShellStore {
  const form = signal<ShellForm>(initialForm());
  const storedTheme = preferences.get(THEME_KEY);
  const theme = signal<ThemeMode>(THEME_MODES.find((mode) => mode === storedTheme) ?? 'system');
  const sectionUnavailable = signal(false);

  const patch = (change: Partial<ShellForm>): void => {
    form.value = { ...form.value, ...change };
  };
  const clearErrors = (): void => patch({ error: null, issues: [] });

  // Запрос с busy; отказ пишет текст по коду ошибки, исключение — общий текст 'unknown'; busy сбрасывается всегда.
  async function attempt(request: () => Promise<AuthResult>): Promise<boolean> {
    patch({ busy: true });
    let result: AuthResult;
    try {
      result = await request();
    } catch {
      patch({ error: authErrorText('unknown') });
      return false;
    } finally {
      patch({ busy: false });
    }
    if (result.ok) return true;
    patch({ error: authErrorText(result.code) });
    return false;
  }

  return {
    form,
    theme,
    sectionUnavailable,

    async login(email, password, returnTo) {
      clearErrors();
      return (await attempt(() => session.login(email, password))) ? safeReturnTo(returnTo) : null;
    },

    async register(email) {
      clearErrors();
      const checked = validateEmailForm({ email });
      if (!checked.ok) {
        patch({ issues: checked.issues });
        return;
      }
      if (await attempt(() => session.register(checked.email))) patch({ sent: true });
    },

    async confirmRegistration(input) {
      clearErrors();
      const checked = validateConfirmForm(input);
      if (!checked.ok) {
        patch({ issues: checked.issues });
        return null;
      }
      return (await attempt(() => session.confirmRegistration(checked.body))) ? '/' : null;
    },

    async acceptInvitation(input) {
      clearErrors();
      const checked = validateInviteForm(input);
      if (!checked.ok) {
        patch({ issues: checked.issues });
        return null;
      }
      return (await attempt(() => session.acceptInvitation(checked.body))) ? '/' : null;
    },

    async logout() {
      clearErrors();
      await session.logout();
    },

    setTheme(mode) {
      theme.value = mode;
      preferences.set(THEME_KEY, mode);
    },

    setSectionUnavailable(flag) {
      sectionUnavailable.value = flag;
    },

    resetForm() {
      form.value = initialForm();
    },
  };
}
