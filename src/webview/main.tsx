import { render } from "preact";

import { App } from "./App";
import { RpcClient } from "./rpcClient";
import "uplot/dist/uPlot.min.css";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  render(<App rpc={new RpcClient()} />, root);
}
