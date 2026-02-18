# hue-lights

Control Philips Hue lights via the OpenHue CLI with color and brightness presets.

## Usage

```bash
# Basic usage
hue-lights --scene <scene_name>

# Custom color and brightness
hue-lights --color <color_hex> --brightness <0-100>
```

## Scenes

| Scene       | Color                   | Brightness | Description            |
| ----------- | ----------------------- | ---------- | ---------------------- |
| `goodnight` | #8B4513 (saddle brown)  | 15%        | Dark, cozy bedtime     |
| `sleepy`    | #CD853F (peru)          | 15%        | Warm, moody sleep mode |
| `active`    | #FFFFFF (white)         | 100%       | Bright, energized      |
| `relax`     | #FFB347 (sunset)        | 80%        | Warm, calming          |
| `focus`     | #00FF00 (matrix green)  | 90%        | Work mode              |
| `reading`   | #FFD700 (gold)          | 85%        | Cozy reading light     |
| `cinema`    | #191970 (midnight blue) | 60%        | Movie time             |
| `party`     | #FF0000                 | 100%       | Party mode             |

## Color Codes

You can specify custom hex colors: `--color #RRGGBB`

## Light Configuration

- Lights: 14 Hue color lamps (all in "Living room")
- Bridge IP: 192.168.1.7
- Username: lkIq5STG50rJ8089ywSI5iPct7cAVdCb23I4YaWv

## Examples

```bash
# Set to dark warm brown
hue-lights --color "#CD853F" --brightness 15

# Use a scene
hue-lights --scene sleepy

# Custom amber glow
hue-lights --color "#FFB347" --brightness 80
```
