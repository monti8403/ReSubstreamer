import type { ColorValue } from 'react-native';
import Svg, { G, Path, type PathProps } from 'react-native-svg';

const LOGO_PATH = 'M480 200H544V360H600L752 800H672L542 424H482L352 800H272L424 360H480Z';
const INNER_PATH = 'M498.9 595.0L525.1 595.0L554.5 680.0L469.5 680.0Z';
const LOGO_TRANSFORM = 'translate(0 12)';

type Props = {
  /** Overall bounding square size (dp). */
  size?: number;
  /** Fill colour. Accepts RN `ColorValue` (including tab-bar `OpaqueColorValue`). */
  color?: ColorValue;
};

export function AtrumLogo({ size = 130, color = '#F4F6FA' }: Props) {
  const fill = color as PathProps['fill'];
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <G transform={LOGO_TRANSFORM} fill={fill}>
        <Path d={LOGO_PATH} fill={fill} />
        <Path d={INNER_PATH} fill={fill} />
      </G>
    </Svg>
  );
}

export default AtrumLogo;
