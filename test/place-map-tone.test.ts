import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { tone } from '../public/place-map.js';

// 「而且地圖顏色好怪」 (2026-11-28): the dark map was OpenFreeMap's fiord, blue land
// and teal labels beside the app's neutral greys. Now a plain style recoloured to
// the app's palette, layer by layer. The layers below are the kinds OpenFreeMap's
// dark and positron styles draw, with their own (near-black) colours.
const layers = () => [
  { id: 'background', type: 'background', paint: { 'background-color': 'rgb(12,12,12)' } },
  { id: 'water', type: 'fill', paint: { 'fill-color': 'rgb(27 ,27 ,29)' } },
  { id: 'landcover_wood', type: 'fill', paint: { 'fill-color': 'rgb(32,32,32)' } },
  { id: 'building', type: 'fill', paint: { 'fill-color': 'rgb(10,10,10)', 'fill-outline-color': 'rgb(27 ,27 ,29)' } },
  { id: 'highway_minor', type: 'line', paint: { 'line-color': '#181818' } },
  { id: 'highway_major_casing', type: 'line', paint: { 'line-color': 'rgba(60,60,60,0.8)' } },
  { id: 'highway_motorway_inner', type: 'line', paint: { 'line-color': ['interpolate', ['linear'], ['zoom'], 5.8, 'hsla(0,0%,85%,0.53)', 6, '#000'] } },
  { id: 'railway_dashline', type: 'line', paint: { 'line-color': 'rgb(12,12,12)' } },
  { id: 'place_city', type: 'symbol', layout: { 'text-field': '{name}' }, paint: { 'text-color': 'rgb(101,101,101)', 'text-halo-color': 'rgba(0,0,0,0.7)' } },
  { id: 'highway_name_other', type: 'symbol', layout: { 'text-field': '{name}' }, paint: { 'text-color': 'rgba(80, 78, 78, 1)' } },
  { id: 'water_name', type: 'symbol', layout: { 'text-field': '{name}' }, paint: {} },
  { id: 'road_oneway', type: 'symbol', layout: { 'icon-image': 'arrow' } },
];
const paintOf = (style: any, id: string) => style.layers.find((layer: any) => layer.id === id).paint ?? {};

describe('the place map in the app colours', () => {
  it('dark: land on the app greys, water a step darker, labels light grey on a grey halo', () => {
    const style = tone({ version: 8, layers: layers() }, 'dark');
    expect(paintOf(style, 'background')['background-color']).toBe('#383a3f');
    expect(paintOf(style, 'water')['fill-color']).toBe('#1f2124');
    expect(paintOf(style, 'building')).toMatchObject({ 'fill-color': '#424449', 'fill-outline-color': '#4a4c52' });
    expect(paintOf(style, 'highway_minor')['line-color']).toBe('#46484e');
    expect(paintOf(style, 'highway_major_casing')['line-color']).toBe('#2e3034');
    expect(paintOf(style, 'highway_motorway_inner')['line-color']).toBe('#61646c');
    expect(paintOf(style, 'railway_dashline')['line-color']).toBe('#383a3f');
    expect(paintOf(style, 'place_city')).toMatchObject({ 'text-color': '#c4c8ce', 'text-halo-color': '#2b2d31', 'text-halo-width': 1.2 });
    expect(paintOf(style, 'highway_name_other')['text-color']).toBe('#8e9297');
    expect(paintOf(style, 'water_name')['text-color']).toBe('#6f747c');
    // An icon-only layer keeps its paint.
    expect(paintOf(style, 'road_oneway')).toEqual({});
  });

  it('light: warm paper, white roads, the app’s dark text', () => {
    const style = tone({ version: 8, layers: layers() }, 'light');
    expect(paintOf(style, 'background')['background-color']).toBe('#f4f2ed');
    expect(paintOf(style, 'highway_minor')['line-color']).toBe('#ffffff');
    expect(paintOf(style, 'place_city')['text-color']).toBe('#56534d');
  });
});
