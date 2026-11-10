import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { ArtistSelectSheet } from '../ArtistSelectSheet';
import { resolveArtistId } from '@/services/artistResolutionService';

jest.mock('../../BottomSheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? <View testID="bottom-sheet">{children}</View> : null,
  };
});

jest.mock('@/services/artistResolutionService', () => ({
  resolveArtistId: jest.fn(),
}));

jest.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#FF5500',
      card: '#1E1E1E',
      textPrimary: '#FFFFFF',
      textSecondary: '#AAAAAA',
    },
  }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string) => def || key,
  }),
}));

describe('ArtistSelectSheet', () => {
  const mockOnClose = jest.fn();
  const mockOnSelectArtist = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders artist list when visible', () => {
    const artists = [
      { id: '1', name: 'Artie 5ive' },
      { id: '2', name: 'Kid Yugi' },
    ];

    const { getByText, getByTestId } = render(
      <ArtistSelectSheet
        visible={true}
        artists={artists}
        onClose={mockOnClose}
        onSelectArtist={mockOnSelectArtist}
      />,
    );

    expect(getByText('Artisti')).toBeTruthy();
    expect(getByText('Artie 5ive')).toBeTruthy();
    expect(getByText('Kid Yugi')).toBeTruthy();
    expect(getByTestId('artist-select-item-Artie 5ive')).toBeTruthy();
  });

  it('calls onSelectArtist directly when artist already has an id', () => {
    const artists = [
      { id: 'artie-1', name: 'Artie 5ive' },
      { id: 'kid-2', name: 'Kid Yugi' },
    ];

    const { getByTestId } = render(
      <ArtistSelectSheet
        visible={true}
        artists={artists}
        onClose={mockOnClose}
        onSelectArtist={mockOnSelectArtist}
      />,
    );

    fireEvent.press(getByTestId('artist-select-item-Artie 5ive'));
    expect(mockOnSelectArtist).toHaveBeenCalledWith({
      id: 'artie-1',
      name: 'Artie 5ive',
    });
    expect(resolveArtistId).not.toHaveBeenCalled();
  });

  it('resolves artist id if artist has no id when pressed', async () => {
    (resolveArtistId as jest.Mock).mockResolvedValueOnce('resolved-kid-yugi');
    const artists = [
      { id: 'artie-1', name: 'Artie 5ive' },
      { id: undefined, name: 'Kid Yugi' },
    ];

    const { getByTestId } = render(
      <ArtistSelectSheet
        visible={true}
        artists={artists}
        onClose={mockOnClose}
        onSelectArtist={mockOnSelectArtist}
      />,
    );

    fireEvent.press(getByTestId('artist-select-item-Kid Yugi'));

    await waitFor(() => {
      expect(resolveArtistId).toHaveBeenCalledWith('Kid Yugi');
      expect(mockOnSelectArtist).toHaveBeenCalledWith({
        id: 'resolved-kid-yugi',
        name: 'Kid Yugi',
      });
    });
  });
});
