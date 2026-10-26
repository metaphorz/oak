// Parameter schema for the Live Oak Explorer.
// Every slider in the UI is generated from this table, and the same values are
// sent to Blender / Unreal so all three renderers build the same tree.
//
// Units: metres, degrees, years. Compass: 0 = North, 90 = East (Atlantic side
// of Amelia Island), 180 = South, 270 = West. windDir is the direction the
// wind blows FROM, as meteorologists report it.

export const BARK_SETS = {
  jolcham_oak_bark_01: 'Fissured oak (photoscan)',
  tree_bark_03: 'Old ridged bark (photoscan)',
  bark_brown_02: 'Brown knotted bark (photoscan)',
};

export const GROUNDS = {
  hammock: 'Maritime hammock (oak litter, palmetto)',
  edge: 'Forest edge (litter, grasses)',
  dune: 'Dune scrub (sand, sea oats)',
};

export const SCHEMA = [
  {
    group: 'Growth over time',
    open: true,
    params: [
      { key: 'seed', label: 'Seed', min: 1, max: 9999, step: 1, value: 1913, help: 'Random seed; same seed + same sliders = same tree in every renderer.' },
      { key: 'age', label: 'Age', min: 3, max: 250, step: 1, value: 140, unit: 'yr', help: 'Years of growth. Wind effects (lean, pruning, buttressing) accumulate with age.' },
    ],
  },
  {
    group: 'Trunk & roots',
    open: true,
    params: [
      { key: 'trunkHeight', label: 'First limb height', min: 0.3, max: 6, step: 0.1, value: 1.6, unit: 'm', help: 'Live oaks branch low, keeping the centre of gravity low against wind load.' },
      { key: 'trunkLength', label: 'Trunk length', min: 1.5, max: 14, step: 0.1, value: 3.4, unit: 'm', help: 'Open-grown live oaks have a short, massive trunk that divides into several huge limbs.' },
      { key: 'trunkRadius', label: 'Trunk radius', min: 0.15, max: 1.4, step: 0.01, value: 0.7, unit: 'm', help: 'Radius at 150 years; younger trees are thinner.' },
      { key: 'trunkGnarl', label: 'Trunk twist', min: 0, max: 1, step: 0.01, value: 0.35 },
      { key: 'rootFlare', label: 'Root flare', min: 0, max: 1, step: 0.01, value: 0.55, help: 'Swelling of the trunk base.' },
      { key: 'buttress', label: 'Wind buttressing', min: 0, max: 1, step: 0.01, value: 0.65, help: 'Roots and base thicken along the wind axis: tension roots windward, compression roots leeward.' },
      { key: 'rootSpread', label: 'Surface roots', min: 0, max: 1, step: 0.01, value: 0.55 },
      { key: 'rootXray', label: 'X-ray root plate', type: 'bool', value: false, help: 'Make the ground translucent to see the root system.' },
    ],
  },
  {
    group: 'Limbs & branching',
    open: false,
    params: [
      { key: 'limbCount', label: 'Main limbs', min: 2, max: 12, step: 1, value: 8 },
      { key: 'limbAngle', label: 'Limb angle', min: 25, max: 100, step: 1, value: 62, unit: '°', help: 'Angle from vertical. Live oak limbs are nearly horizontal.' },
      { key: 'limbLength', label: 'Limb length', min: 3, max: 24, step: 0.1, value: 13, unit: 'm' },
      { key: 'limbSag', label: 'Limb sag', min: 0, max: 1, step: 0.01, value: 0.45, help: 'Heavy limbs droop; above ~0.8 they may rest an elbow on the ground.' },
      { key: 'limbClearance', label: 'Low limb clearance', min: 0, max: 3, step: 0.05, value: 1.0, unit: 'm', help: 'How high the lowest limbs stay. 0 lets heavy limbs rest an elbow on the ground (or dip into a pond).' },
      { key: 'lightSeeking', label: 'Light seeking', min: 0, max: 1, step: 0.01, value: 0.5, help: 'Shoots grow toward the light field: open sky above, the southern sun path (30.6°N), and skylight plus reflected light over open water.' },
      { key: 'tipUpturn', label: 'Tip upturn', min: 0, max: 1, step: 0.01, value: 0.6 },
      { key: 'sinuosity', label: 'Sinuosity', min: 0, max: 1, step: 0.01, value: 0.6, help: 'Serpentine wandering of limbs.' },
      { key: 'levels', label: 'Branch levels', min: 2, max: 5, step: 1, value: 4 },
      { key: 'children', label: 'Branches per limb', min: 2, max: 10, step: 1, value: 7 },
      { key: 'childAngle', label: 'Branch angle', min: 15, max: 85, step: 1, value: 46, unit: '°' },
      { key: 'lengthRatio', label: 'Length ratio', min: 0.25, max: 0.9, step: 0.01, value: 0.52 },
      { key: 'radiusRatio', label: 'Radius ratio', min: 0.3, max: 0.9, step: 0.01, value: 0.58 },
      { key: 'showSkeleton', label: 'Skeleton view', type: 'bool', value: false, help: 'Show only the branching graph — joints and connections — that every renderer builds on.' },
    ],
  },
  {
    group: 'Salt pruning & wind',
    open: true,
    params: [
      { key: 'windDir', label: 'Wind from', min: 0, max: 359, step: 1, value: 90, unit: '°', type: 'compass', help: 'Prevailing onshore wind. On Amelia Island the Atlantic lies to the east.' },
      { key: 'windStrength', label: 'Wind strength', min: 0, max: 1, step: 0.01, value: 0.6 },
      { key: 'saltExposure', label: 'Salt spray exposure', min: 0, max: 1, step: 0.01, value: 0.6, help: 'Salt aerosol kills windward buds, shearing the crown into a smooth ramp.' },
      { key: 'shearAngle', label: 'Crown shear angle', min: 4, max: 45, step: 1, value: 12, unit: '°', help: 'Slope of the pruned crown surface, rising away from the sea.' },
      { key: 'windLean', label: 'Leeward lean', min: 0, max: 1, step: 0.01, value: 0.3, help: 'Trunk and limbs lean and grow away from the wind over the years.' },
      { key: 'flagging', label: 'Windward flagging', min: 0, max: 1, step: 0.01, value: 0.4, help: 'Branches on the windward side are stunted ("flag" form).' },
      { key: 'saltBurn', label: 'Leaf salt burn', min: 0, max: 1, step: 0.01, value: 0.4, help: 'Browning of exposed windward foliage.' },
      { key: 'deadTwigs', label: 'Dead twig stubs', min: 0, max: 1, step: 0.01, value: 0.5 },
      { key: 'sway', label: 'Sway animation', min: 0, max: 1, step: 0.01, value: 0.35 },
      { key: 'showShear', label: 'Show shear surface', type: 'bool', value: false },
      { key: 'showSpray', label: 'Visualise salt aerosol', type: 'bool', value: false, help: 'Real salt spray is invisible; this faint overlay only traces the wind path for teaching.' },
      { key: 'showArrow', label: 'Wind arrow', type: 'bool', value: true },
    ],
  },
  {
    group: 'Foliage',
    open: false,
    params: [
      { key: 'fullness', label: 'Canopy fullness', min: 0, max: 1, step: 0.01, value: 0.75, help: 'From an open, airy crown to the closed foliage shell of a mature live oak (more twigs, more and larger leaf sprigs).' },
      { key: 'leafDensity', label: 'Sprigs per twig', min: 0, max: 80, step: 1, value: 42, help: 'Each sprig carries five leaves.' },
      { key: 'leafSize', label: 'Leaf size', min: 0.04, max: 0.3, step: 0.005, value: 0.12, unit: 'm', help: 'Real live oak leaves are 4–10 cm.' },
      { key: 'clumping', label: 'Tip clumping', min: 0, max: 1, step: 0.01, value: 0.6 },
      { key: 'interiorShade', label: 'Interior shading', min: 0, max: 1, step: 0.01, value: 0.65, help: 'Shaded inner shoots shed their leaves, leaving a leafy roof over bare, sinuous limbs.' },
      { key: 'leafDarkness', label: 'Leaf darkness', min: 0, max: 1, step: 0.01, value: 0.7, help: 'Live oak foliage is a deep, waxy green.' },
      { key: 'leafGloss', label: 'Leaf gloss', min: 0, max: 1, step: 0.01, value: 0.55 },
      { key: 'leafVariation', label: 'Colour variation', min: 0, max: 1, step: 0.01, value: 0.35 },
      { key: 'translucency', label: 'Translucency', min: 0, max: 1, step: 0.01, value: 0.35 },
    ],
  },
  {
    group: 'Spanish moss',
    open: true,
    params: [
      { key: 'mossDensity', label: 'Density', min: 0, max: 1, step: 0.01, value: 0.5, help: 'Tillandsia usneoides — an epiphyte, not a parasite. Thrives in humid north Florida.' },
      { key: 'mossLength', label: 'Strand length', min: 0.15, max: 3, step: 0.05, value: 1.0, unit: 'm' },
      { key: 'mossClump', label: 'Strands per clump', min: 1, max: 14, step: 1, value: 6 },
      { key: 'mossWidth', label: 'Clump width', min: 0.04, max: 0.5, step: 0.01, value: 0.18, unit: 'm' },
      { key: 'mossTone', label: 'Grey ↔ green', min: 0, max: 1, step: 0.01, value: 0.3 },
      { key: 'mossShelter', label: 'Prefers shelter', min: 0, max: 1, step: 0.01, value: 0.6, help: 'Moss favours humid, leeward, inner limbs over the salt-blasted windward face.' },
    ],
  },
  {
    group: 'Bark',
    open: false,
    params: [
      { key: 'barkSet', label: 'Bark texture', type: 'select', options: BARK_SETS, value: 'jolcham_oak_bark_01' },
      { key: 'barkScale', label: 'Texture scale', min: 0.3, max: 3, step: 0.05, value: 1.1, unit: 'm' },
      { key: 'barkDarkness', label: 'Bark darkness', min: 0, max: 1, step: 0.01, value: 0.35 },
      { key: 'limbMoss', label: 'Limb moss & fern', min: 0, max: 1, step: 0.01, value: 0.35, help: 'Green moss and resurrection fern on the upper faces of limbs.' },
    ],
  },
  {
    group: 'Environment',
    open: false,
    params: [
      { key: 'timeOfDay', label: 'Time of day', min: 6, max: 19.5, step: 0.1, value: 15.5, unit: 'h' },
      { key: 'ground', label: 'Ground', type: 'select', options: GROUNDS, value: 'hammock', help: 'Coastal live oaks grow in maritime hammock: oak leaf litter on sandy soil under saw palmetto, yaupon and wax myrtle.' },
      { key: 'understory', label: 'Understory', min: 0, max: 1, step: 0.01, value: 0.7, help: 'Saw palmetto, yaupon / wax myrtle shrubs, and grasses (sea oats on the dune).' },
      { key: 'showOcean', label: 'Ocean on windward side', type: 'bool', value: true },
      { key: 'pond', label: 'Retention pond beside tree', type: 'bool', value: false, help: 'Open water lets in light: limbs reach out over it, grow longer, sag and can dip into the water.' },
      { key: 'pondDir', label: 'Pond direction', min: 0, max: 359, step: 1, value: 225, unit: '°' },
      { key: 'fog', label: 'Sea haze', min: 0, max: 1, step: 0.01, value: 0.3 },
      { key: 'exposure', label: 'Exposure', min: 0.3, max: 2, step: 0.01, value: 1.0 },
      { key: 'quality', label: 'Quality', type: 'select', options: { draft: 'Draft (fast)', high: 'High', ultra: 'Ultra' }, value: 'high' },
    ],
  },
];

export function defaultParams() {
  const p = {};
  for (const g of SCHEMA) for (const d of g.params) p[d.key] = d.value;
  return p;
}

export function paramDef(key) {
  for (const g of SCHEMA) for (const d of g.params) if (d.key === key) return d;
  return null;
}

// Presets only override what differs from the defaults.
export const PRESETS = {
  'Dune-front salt-sheared (Amelia Island)': {},
  'Grand live oak, sheltered': {
    windStrength: 0.15, saltExposure: 0.05, windLean: 0.2, flagging: 0.1, saltBurn: 0.05,
    limbLength: 17, limbCount: 9, trunkRadius: 1.0, age: 220, mossDensity: 0.8, mossLength: 1.6, limbSag: 0.65,
    ground: 'hammock', showOcean: false, showSpray: false, limbMoss: 0.45, buttress: 0.3,
    fullness: 0.9, interiorShade: 0.55,
  },
  'Maritime forest edge': {
    windStrength: 0.45, saltExposure: 0.4, shearAngle: 14, windLean: 0.4, flagging: 0.35,
    ground: 'edge', mossDensity: 0.6, limbMoss: 0.45,
  },
  'Bluff wind-flagged (extreme)': {
    ground: 'dune',
    windStrength: 1, saltExposure: 1, shearAngle: 26, windLean: 0.75, flagging: 0.9, saltBurn: 0.7,
    trunkHeight: 0.9, limbAngle: 80, limbSag: 0.7, mossDensity: 0.25, buttress: 0.95, age: 110,
  },
  'Wind-swept, bent by salt wind': {
    windStrength: 0.95, saltExposure: 0.75, shearAngle: 18, windLean: 1, flagging: 0.7, saltBurn: 0.5,
    trunkLength: 4.2, trunkGnarl: 0.5, limbAngle: 55, fullness: 0.6, mossDensity: 0.3, buttress: 0.9, age: 160,
  },
  'Live oaks by a retention pond': {
    pond: true, pondDir: 200, windStrength: 0.25, saltExposure: 0.1, flagging: 0.15, windLean: 0.15,
    limbClearance: 0.4, limbSag: 0.65, limbLength: 15, age: 180, mossDensity: 0.7, showOcean: false,
    ground: 'edge',
  },
  'Young oak, 25 years': {
    age: 25, mossDensity: 0.15, limbMoss: 0.1,
  },
  // Live oaks are evergreen — this is a study view of the branch architecture, not a season.
  'Leafless structure (study view)': {
    leafDensity: 0, mossDensity: 0, showSpray: false,
  },
};
