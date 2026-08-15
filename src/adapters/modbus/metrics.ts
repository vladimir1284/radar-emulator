// Contador de transacciones Modbus para la metrica de calidad de enlace
// (docs/implementacion/observabilidad.md#metricas-de-calidad-de-enlace).
// Placeholder de fase 1: cuenta invocaciones al vector, exitosas o no.
export class ModbusTransactionCounter {
  private count = 0;

  increment(): void {
    this.count += 1;
  }

  // Lee y resetea: se llama una vez por segundo desde el emisor de metricas.
  takeAndReset(): number {
    const n = this.count;
    this.count = 0;
    return n;
  }
}
