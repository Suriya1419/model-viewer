
/* @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Matrix4, Vector2} from 'three';
import {CSS2DRenderer} from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import ModelViewerElementBase, {$needsRender, $onResize, $scene, $tick, toVector3D, Vector3D} from '../model-viewer-base.js';
import {Hotspot, HotspotConfiguration} from '../three-components/Hotspot.js';
import {Constructor} from '../utilities.js';

const $annotationRenderer = Symbol('annotationRenderer');
const $hotspotMap = Symbol('hotspotMap');
const $mutationCallback = Symbol('mutationCallback');
const $observer = Symbol('observer');
const $addHotspot = Symbol('addHotspot');
const $removeHotspot = Symbol('removeHotspot');

// Used internally by positionAndNormalFromPoint()
const pixelPosition = new Vector2();
const worldToModel = new Matrix4();

export declare interface AnnotationInterface {
  updateHotspot(config: HotspotConfiguration): void;
  positionAndNormalFromPoint(pixelX: number, pixelY: number):
      {position: Vector3D, normal: Vector3D}|null
}

/**
 * AnnotationMixin implements a declarative API to add hotspots and annotations.
 * Child elements of the <model-viewer> element that have a slot name that
 * begins with "hotspot" and data-position and data-normal attributes in
 * the format of the camera-target attribute will be added to the scene and
 * track the specified model coordinates.
 */
export const AnnotationMixin = <T extends Constructor<ModelViewerElementBase>>(
    ModelViewerElement: T): Constructor<AnnotationInterface>&T => {
  class AnnotationModelViewerElement extends ModelViewerElement {
    private[$annotationRenderer] = new CSS2DRenderer();
    private[$hotspotMap] = new Map<string, Hotspot>();
    private[$mutationCallback] = (mutations: Array<unknown>) => {
      mutations.forEach((mutation) => {
        // NOTE: Be wary that in ShadyDOM cases, the MutationRecord
        // only has addedNodes and removedNodes (and no other details).
        if (!(mutation instanceof MutationRecord) ||
            mutation.type === 'childList') {
          (mutation as MutationRecord).addedNodes.forEach((node) => {
            this[$addHotspot](node);
          });
          (mutation as MutationRecord).removedNodes.forEach((node) => {
            this[$removeHotspot](node);
          });
          this[$needsRender]();
        }
      });
    };
    private[$observer] = new MutationObserver(this[$mutationCallback]);

    constructor(...args: Array<any>) {
      super(...args);

      const shadowRoot = this.shadowRoot!;
      const {domElement} = this[$annotationRenderer];
      domElement.classList.add('annotation-container');
      shadowRoot.querySelector('.container')!.appendChild(domElement);
      domElement.appendChild(shadowRoot.querySelector('.default')!);
    }

    connectedCallback() {
      super.connectedCallback();

      for (let i = 0; i < this.children.length; ++i) {
        this[$addHotspot](this.children[i]);
      }

      const {ShadyDOM} = self as any;

      if (ShadyDOM == null) {
        this[$observer].observe(this, {childList: true});
      } else {
        this[$observer] =
            ShadyDOM.observeChildren(this, this[$mutationCallback]);
      }
    }

    disconnectedCallback() {
      super.disconnectedCallback();

      const {ShadyDOM} = self as any;

      if (ShadyDOM == null) {
        this[$observer].disconnect();
      } else {
        ShadyDOM.unobserveChildren(this[$observer]);
      }
    }

    /**
     * Since the data-position and data-normal attributes are not observed, use
     * this method to move a hotspot. Keep in mind that all hotspots with the
     * same slot name use a single location and the first definition takes
     * precedence, until updated with this method.
     */
    updateHotspot(config: HotspotConfiguration) {
      const hotspot = this[$hotspotMap].get(config.name);

      if (hotspot == null) {
        return;
      }

      hotspot.updatePosition(config.position);
      hotspot.updateNormal(config.normal);
    }

    /**
     * This method returns the model position and normal of the point on the
     * mesh corresponding to the input pixel coordinates given relative to the
     * model-viewer element. The position and normal are returned as strings in
     * the format suitable for putting in a hotspot's data-position and
     * data-normal attributes. If the mesh is not hit, the result is null.
     */
    positionAndNormalFromPoint(pixelX: number, pixelY: number):
        {position: Vector3D, normal: Vector3D}|null {
      const scene = this[$scene];
      const {width, height, model} = scene;
      pixelPosition.set(pixelX / width, pixelY / height)
          .multiplyScalar(2)
          .subScalar(1);
      pixelPosition.y *= -1;

      const hit = scene.positionAndNormalFromPoint(pixelPosition);
      if (hit == null) {
        return null;
      }

      worldToModel.getInverse(model.matrixWorld);
      const position = toVector3D(hit.position.applyMatrix4(worldToModel));
      const normal = toVector3D(hit.normal);
      return {position: position, normal: normal};
    }

    [$tick](time: number, delta: number) {
      super[$tick](time, delta);
      const scene = this[$scene];
      const camera = scene.getCamera();

      if (scene.isDirty) {
        scene.model.updateHotspots(camera.position);
        this[$annotationRenderer].render(scene, camera);
      }
    }

    [$onResize](e: {width: number, height: number}) {
      super[$onResize](e);
      this[$annotationRenderer].setSize(e.width, e.height);
    }

    private[$addHotspot](node: Node) {
      if (!(node instanceof HTMLElement &&
            node.slot.indexOf('hotspot') === 0)) {
        return;
      }

      let hotspot = this[$hotspotMap].get(node.slot);

      if (hotspot != null) {
        hotspot.increment();
      } else {
        hotspot = new Hotspot({
          name: node.slot,
          position: node.dataset.position,
          normal: node.dataset.normal,
        });
        this[$hotspotMap].set(node.slot, hotspot);
        this[$scene].model.addHotspot(hotspot);
        // This happens automatically in render(), but we do it early so that
        // the slots appear in the shadow DOM and the elements get attached,
        // allowing us to dispatch events on them.
        this[$annotationRenderer].domElement.appendChild(hotspot.element);
      }
      this[$scene].isDirty = true;
    }

    private[$removeHotspot](node: Node) {
      if (!(node instanceof HTMLElement)) {
        return;
      }

      const hotspot = this[$hotspotMap].get(node.slot);

      if (!hotspot) {
        return;
      }

      if (hotspot.decrement()) {
        this[$scene].model.removeHotspot(hotspot);
        this[$hotspotMap].delete(node.slot);
      }
      this[$scene].isDirty = true;
    }
  }

  return AnnotationModelViewerElement;
};
