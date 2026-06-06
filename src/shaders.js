// GLSL pair for the spiral's curved image tiles.
// Vertex shader hands the fragment shader the tile UV and a world-space
// position; the fragment paints the texture with a quiet edge falloff
// and a soft depth wash so tiles far from the camera sink into the bg.

export const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;

    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;

    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

export const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uMap;
  uniform vec3 uCameraPosition;

  varying vec2 vUv;
  varying vec3 vWorldPosition;

  void main() {
    vec4 tex = texture2D(uMap, vUv);

    // Light ground — tiles dissolve into white instead of black.
    vec3 fade = vec3(1.0);

    // Soft fade around each tile edge.
    vec2 centered = vUv - 0.5;
    float r = length(centered);
    float edge = 1.0 - smoothstep(0.34, 0.86, r);
    edge = mix(0.55, 1.0, edge);

    // Distance from camera → depth fade toward the white background.
    float dist = distance(vWorldPosition, uCameraPosition);
    float depth = 1.0 - smoothstep(8.0, 22.0, dist);
    depth = mix(0.18, 1.0, depth);

    // Near tiles keep full colour; far tiles desaturate slightly.
    vec3 color = tex.rgb;
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    vec3 washed = mix(vec3(luma), color, 0.85);
    color = mix(washed, color, depth);

    // Blend toward white by both edge softness and depth.
    float blend = edge * depth;
    color = mix(fade, color, blend);

    gl_FragColor = vec4(color, tex.a);
  }
`;
