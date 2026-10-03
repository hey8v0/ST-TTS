import {checkWorkflow, comfyParams, DEFAULT_COMFY_WORKFLOW, workflowPlaceholders} from './image-engines.js';
import {inspectLoras, normalizeDisabledLoras, activeLoraWorkflow} from './comfy-loras.js';

/** Session-only working copy. No settings writes until an explicit save. */
export function patchComfyDraft(value, patch = {}) {
  const workflow = checkWorkflow(patch.workflow ?? value.workflow);
  const disabledLoras = normalizeDisabledLoras(workflow, patch.disabledLoras ?? value.disabledLoras);
  activeLoraWorkflow(workflow || DEFAULT_COMFY_WORKFLOW, disabledLoras);
  return {...value, ...comfyParams({...value, ...patch.params}), workflow, disabledLoras};
}

export function describeComfyDraft(edit, current) {
  const {value, base} = edit, workflow = value.workflow || DEFAULT_COMFY_WORKFLOW;
  const placeholders = workflowPlaceholders(workflow);
  const controls = placeholders.map(k => k === 'clip_skip' ? 'clipSkip' : k);
  return {...edit, dirty: JSON.stringify(value) !== JSON.stringify(base),
    conflict: JSON.stringify(current) !== JSON.stringify(base), controls, loras: inspectLoras(workflow),
    missing: controls.includes('model') && !value.model ? '先在参数里选择模型' : ''};
}
