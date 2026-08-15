import net from "net";
import Modbus from "jsmodbus";

// Fase 0 / PEND-21: comprobar si jsmodbus enruta por unitId sobre una sola
// conexion TCP. Dos buffers de holding registers distintos, uno por "unit id"
// logico. Si jsmodbus enrutara de verdad, leer unitId 1 y unitId 2 deberia
// devolver valores distintos.

const holdingUnit1 = Buffer.alloc(1024);
holdingUnit1.writeUInt16BE(111, 0); // valor centinela para unit 1

const netServer = new net.Server();
// jsmodbus no acepta un mapa de buffers por unitId: un solo set de buffers
// para todo el ModbusTCPServer, sin im import de unitId en ningun punto del
// pipeline de respuesta (confirmado leyendo modbus-server-response-handler.js).
const server = new Modbus.server.TCP(netServer, { holding: holdingUnit1 });

netServer.listen(15020, async () => {
  const socket = new net.Socket();
  const clientUnit1 = new Modbus.client.TCP(socket, 1);
  const clientUnit2 = new Modbus.client.TCP(socket, 2);

  socket.connect({ host: "127.0.0.1", port: 15020 }, async () => {
    try {
      // Escribimos 222 en la direccion 0 via unit 2, para ver si "contamina"
      // lo que lee unit 1 (si contamina => buffer compartido, no hay routing).
      await clientUnit2.writeSingleRegister(0, 222);

      const respUnit1 = await clientUnit1.readHoldingRegisters(0, 1);
      const respUnit2 = await clientUnit2.readHoldingRegisters(0, 1);

      console.log("RESULT unit1=", respUnit1.response.body.values[0]);
      console.log("RESULT unit2=", respUnit2.response.body.values[0]);

      if (respUnit1.response.body.values[0] === respUnit2.response.body.values[0]) {
        console.log("VEREDICTO: buffer compartido entre unit IDs -> NO hay multi-unit routing");
      } else {
        console.log("VEREDICTO: unit IDs aislados -> SI hay multi-unit routing");
      }
    } catch (e: any) {
      console.error("ERROR", e && e.message, e && e.stack);
    } finally {
      socket.end();
      netServer.close();
    }
  });
});
