/* eslint-disable vue/multi-word-component-names */
import {
  defineComponent,
  shallowRef,
  toRefs,
  watch,
  computed,
  inject,
  onMounted,
  onBeforeUnmount,
  h,
  nextTick,
  watchEffect,
  getCurrentInstance,
  InjectionKey,
  PropType,
} from "vue";

import { init as initChart } from "echarts";

import {
  usePublicAPI,
  useAutoresize,
  autoresizeProps,
  useLoading,
  loadingProps
} from "./composables";
import { isOn, omitOn, unwrapInjected } from "./utils";
import { register, TAG_NAME } from "./wc";

import type {
  EChartsType,
  EventTarget,
  Option,
  Theme,
  ThemeInjection,
  InitOptions,
  InitOptionsInjection,
  UpdateOptions,
  UpdateOptionsInjection,
  Emits
} from "./types";
import type { EChartsElement } from "./wc";

import "./style.css";

const __CSP__ = false;
const wcRegistered = __CSP__ ? false : register();

export const THEME_KEY = "ecTheme" as unknown as InjectionKey<ThemeInjection>;
export const INIT_OPTIONS_KEY =
  "ecInitOptions" as unknown as InjectionKey<InitOptionsInjection>;
export const UPDATE_OPTIONS_KEY =
  "ecUpdateOptions" as unknown as InjectionKey<UpdateOptionsInjection>;
export { LOADING_OPTIONS_KEY } from "./composables";

const NATIVE_EVENT_RE = /(^&?~?!?)native:/;

export default defineComponent({
  name: "echarts",
  props: {
    option: Object as PropType<Option>,
    theme: {
      type: [Object, String] as PropType<Theme>
    },
    initOptions: Object as PropType<InitOptions>,
    updateOptions: Object as PropType<UpdateOptions>,
    group: String,
    manualUpdate: Boolean,
    ...autoresizeProps,
    ...loadingProps
  },
  emits: {} as unknown as Emits,
  inheritAttrs: false,
  setup(props, { attrs }) {
    const root = shallowRef<EChartsElement>();
    const chart = shallowRef<EChartsType>();
    const manualOption = shallowRef<Option>();
    const defaultTheme = inject(THEME_KEY, null);
    const defaultInitOptions = inject(INIT_OPTIONS_KEY, null);
    const defaultUpdateOptions = inject(UPDATE_OPTIONS_KEY, null);

    const { autoresize, manualUpdate, loading, loadingOptions } = toRefs(props);

    const realOption = computed(
      () => manualOption.value || props.option || null
    );
    const realTheme = computed(
      () => props.theme || unwrapInjected(defaultTheme, {})
    );
    const realInitOptions = computed(
      () => props.initOptions || unwrapInjected(defaultInitOptions, {})
    );
    const realUpdateOptions = computed(
      () => props.updateOptions || unwrapInjected(defaultUpdateOptions, {})
    );
    const nonEventAttrs = computed(() => omitOn(attrs));
    const nativeListeners: Record<string, unknown> = {};

    // @ts-expect-error listeners for Vue 2 compatibility
    const listeners = getCurrentInstance().proxy.$listeners;
    const realListeners: Record<string, any> = {};

    Object.keys(listeners).forEach(key => {
      if (NATIVE_EVENT_RE.test(key)) {
        nativeListeners[key.replace(NATIVE_EVENT_RE, "$1")] = listeners[key];
      } else {
        realListeners[key] = listeners[key];
      }
    });

    function init(option?: Option) {
      if (!root.value) {
        return;
      }

      const instance = (chart.value = initChart(
        root.value,
        realTheme.value,
        realInitOptions.value
      ));

      if (props.group) {
        instance.group = props.group;
      }

      Object.keys(realListeners).forEach(key => {
        let handler = realListeners[key];

        if (!handler) {
          return;
        }

        let event = key.toLowerCase();
        if (event.charAt(0) === "~") {
          event = event.substring(1);
          handler.__once__ = true;
        }

        let target: EventTarget = instance as unknown as EventTarget;
        if (event.indexOf("zr:") === 0) {
          target = instance.getZr() as unknown as EventTarget;
          event = event.substring(3);
        }

        if (handler.__once__) {
          delete handler.__once__;

          const raw = handler;

          handler = (...args: any[]) => {
            raw(...args);
            target.off(event, handler);
          };
        }

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore EChartsType["on"] is not compatible with ZRenderType["on"]
        // but it's okay here
        target.on(event, handler);
      });

      function resize() {
        if (instance && !instance.isDisposed()) {
          instance.resize();
        }
      }

      function commit() {
        const opt = option || realOption.value;
        if (opt) {
          instance.setOption(opt, realUpdateOptions.value);
        }
      }

      if (autoresize.value) {
        // Try to make chart fit to container in case container size
        // is changed synchronously or in already queued microtasks
        nextTick(() => {
          resize();
          commit();
        });
      } else {
        commit();
      }
    }

    function setOption(option: Option, updateOptions?: UpdateOptions) {
      if (props.manualUpdate) {
        manualOption.value = option;
      }

      if (!chart.value) {
        init(option);
      } else {
        chart.value.setOption(option, updateOptions || {});
      }
    }

    function cleanup() {
      if (chart.value) {
        chart.value.dispose();
        chart.value = undefined;
      }
    }

    let unwatchOption: (() => void) | null = null;
    watch(
      manualUpdate,
      manualUpdate => {
        if (typeof unwatchOption === "function") {
          unwatchOption();
          unwatchOption = null;
        }

        if (!manualUpdate) {
          unwatchOption = watch(
            () => props.option,
            (option, oldOption) => {
              if (!option) {
                return;
              }
              if (!chart.value) {
                init();
              } else {
                chart.value.setOption(option, {
                  // mutating `option` will lead to `notMerge: false` and
                  // replacing it with new reference will lead to `notMerge: true`
                  notMerge: option !== oldOption,
                  ...realUpdateOptions.value
                });
              }
            },
            { deep: true }
          );
        }
      },
      {
        immediate: true
      }
    );

    watch(
      [realTheme, realInitOptions],
      () => {
        cleanup();
        init();
      },
      {
        deep: true
      }
    );

    watchEffect(() => {
      if (props.group && chart.value) {
        chart.value.group = props.group;
      }
    });

    const publicApi = usePublicAPI(chart);

    useLoading(chart, loading, loadingOptions);

    useAutoresize(chart, autoresize, root);

    onMounted(() => {
      init();
    });

    onBeforeUnmount(() => {
      if (wcRegistered && root.value) {
        // For registered web component, we can leverage the
        // `disconnectedCallback` to dispose the chart instance
        // so that we can delay the cleanup after exsiting leaving
        // transition.
        root.value.__dispose = cleanup;
      } else {
        cleanup();
      }
    });

    return {
      chart,
      root,
      setOption,
      nonEventAttrs,
      nativeListeners,
      ...publicApi
    };
  },
  render() {
    const attrs = (
      { attrs: this.nonEventAttrs, on: this.nativeListeners }
    ) as any;
    attrs.ref = "root";
    attrs.class = attrs.class ? ["echarts"].concat(attrs.class) : "echarts";
    return h(TAG_NAME, attrs);
  }
});
