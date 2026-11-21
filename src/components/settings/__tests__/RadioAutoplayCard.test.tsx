jest.mock('../../../store/persistence/kvStorage', () =>
  require('../../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../../services/secureKeyVault', () => ({
  loadApiKeySecret: jest.fn().mockResolvedValue(''),
  saveApiKeySecret: jest.fn().mockResolvedValue(undefined),
  clearApiKeySecret: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'dark',
    colors: {
      primary: '#ff6600',
      textPrimary: '#F4F6FA',
      textSecondary: '#8E8E98',
      label: '#9A9AA6',
      border: '#1E1E24',
      card: '#0B0B0E',
      inputBg: '#000000',
    },
  }),
}));

import { fireEvent, render, screen } from '@testing-library/react-native';

import { RadioAutoplayCard } from '../RadioAutoplayCard';
import { radioAiSettingsStore } from '../../../store/radioAiSettingsStore';
import { serverInfoStore } from '../../../store/serverInfoStore';

describe('RadioAutoplayCard — Sonic Similarity UI', () => {
  beforeEach(() => {
    serverInfoStore.getState().clearServerInfo();
    radioAiSettingsStore.getState().resetRadioAiSettings();
  });

  it('hides the sonicSimilarity switch and shows a discreet non-detected notice when unsupported', () => {
    render(<RadioAutoplayCard />);

    expect(screen.queryByTestId('radio-sonic-similarity-badge')).toBeNull();
    expect(screen.queryByTestId('radio-source-sonicSimilarity-switch')).toBeNull();
    expect(screen.getByTestId('radio-sonic-similarity-unavailable')).toBeTruthy();
  });

  it('shows Sonic Similarity v1 badge and toggleable source switch when server supports sonicSimilarity', () => {
    serverInfoStore.getState().setOpenSubsonicExtensions([
      { name: 'sonicSimilarity', versions: [1] },
    ]);

    render(<RadioAutoplayCard />);

    expect(screen.getByTestId('radio-sonic-similarity-badge')).toBeTruthy();
    expect(screen.queryByTestId('radio-sonic-similarity-unavailable')).toBeNull();

    const toggle = screen.getByTestId('radio-source-sonicSimilarity-switch');
    expect(toggle.props.value ?? toggle.props.on).toBe(true);

    fireEvent(toggle, 'valueChange', false);
    expect(radioAiSettingsStore.getState().sources.sonicSimilarity).toBe(false);
  });
});
