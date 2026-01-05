import { v4 as uuidv4 } from "uuid";
// keep your existing imports...
export async function getOrderTimeline(req, res) {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        message: "orderId required",
      });
    }

    const pk = `ORDER#${orderId}`;

    const out = await ddb.send(
      new QueryCommand({
        TableName: TABLE_TIMELINE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": pk,
        },
        ScanIndexForward: true, // oldest -> latest
      })
    );

    return res.json({
      ok: true,
      orderId,
      items: out.Items || [],
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || String(e),
    });
  }
}
export async function managerConfirmMerge({
  companyCode,
  date,
  time,
  mergeKey,
  managerId,
}) {
  validateSlotDate(date);

  if (!companyCode || !date || !time || !mergeKey) {
    throw new Error("companyCode, date, time, mergeKey required");
  }

  const rules = await getRules(companyCode);
  const threshold = rules.threshold;

  const pk = pkFor(companyCode, date);
  const mergeSk = skForMergeSlot(time, mergeKey);

  // ✅ Merge slot
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
    })
  );

  const item = res.Item;
  if (!item) throw new Error("Merge slot not found");

  const total = Number(item.totalAmount || 0);
  if (total < threshold) throw new Error("Not enough amount to confirm");

  // ✅ find available FULL slot
  let chosenPos = null;
  for (const p of ALL_POSITIONS) {
    const slotSk = skForSlot(time, "FULL", p);

    const cap = await ddb.send(
      new GetCommand({
        TableName: TABLE_CAPACITY,
        Key: { pk, sk: slotSk },
      })
    );

    const status = String(cap.Item?.status || "AVAILABLE").toUpperCase();
    if (status === "AVAILABLE") {
      chosenPos = p;
      break;
    }
  }

  if (!chosenPos) throw new Error("❌ No FULL slots available");

  // ✅ mark FULL slot booked
  const fullSk = skForSlot(time, "FULL", chosenPos);

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: fullSk },
      UpdateExpression: "SET #s = :b, userId = :uid",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":b": "BOOKED",
        ":uid": mergeKey,
      },
    })
  );

  // ✅ confirm merge slot
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_CAPACITY,
      Key: { pk, sk: mergeSk },
      UpdateExpression:
        "SET tripStatus=:s, blink=:b, confirmedBy=:m, confirmedAt=:t, pos=:p",
      ExpressionAttributeValues: {
        ":s": "FULL",
        ":b": false,
        ":m": String(managerId || "MANAGER"),
        ":t": new Date().toISOString(),
        ":p": chosenPos,
      },
    })
  );

  // ✅ fetch all HALF bookings for this mergeKey
  const allBookingsRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_BOOKINGS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    })
  );

  const bookings = (allBookingsRes.Items || []).filter(
    (b) =>
      String(b.mergeKey || "") === String(mergeKey) &&
      String(b.slotTime || "") === String(time) &&
      String(b.vehicleType || "").toUpperCase() === "HALF"
  );

  if (bookings.length < 2) throw new Error("Not enough HALF bookings");

  // ✅ Create FULL master OrderId
  const fullOrderId = `ORD_FULL_${uuidv4().slice(0, 8)}`;

  const mergedOrderIds = bookings.map((b) => String(b.orderId)).filter(Boolean);

  // ✅ create FULL order META (one card)
  await ddb.send(
    new PutCommand({
      TableName: "tickin_orders",
      Item: {
        pk: `ORDER#${fullOrderId}`,
        sk: "META",
        orderId: fullOrderId,
        companyCode,
        distributorId: bookings[0].distributorCode,
        distributorName: bookings[0].distributorName,
        mergeKey,
        mergedOrderIds,
        slotDate: date,
        slotTime: time,
        slotVehicleType: "FULL",
        slotPos: chosenPos,
        totalAmount: total,
        status: "SLOT_BOOKED",
        createdAt: new Date().toISOString(),
        createdBy: String(managerId || "MANAGER"),
      },
    })
  );

  // ✅ update each booking + each order meta
  for (const b of bookings) {
    // ✅ booking confirmed
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_BOOKINGS,
        Key: { pk, sk: b.sk },
        UpdateExpression:
          "SET #st=:c, confirmedBy=:m, confirmedAt=:t, slotPos=:p, slotVehicleType=:vt, mergedIntoOrderId=:fo",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":c": "CONFIRMED",
          ":m": String(managerId || "MANAGER"),
          ":t": new Date().toISOString(),
          ":p": chosenPos,
          ":vt": "FULL",
          ":fo": fullOrderId,
        },
      })
    );

    // ✅ Update Half Order META -> link to Full Order
    if (b.orderId) {
      await ddb.send(
        new UpdateCommand({
          TableName: "tickin_orders",
          Key: { pk: `ORDER#${b.orderId}`, sk: "META" },
          UpdateExpression:
            "SET mergedIntoOrderId=:fo, mergeKey=:mk, slotVehicleType=:vt, slotPos=:p, tripStatus=:ts, updatedAt=:u",
          ExpressionAttributeValues: {
            ":fo": fullOrderId,
            ":mk": mergeKey,
            ":vt": "FULL",
            ":p": chosenPos,
            ":ts": "CONFIRMED",
            ":u": new Date().toISOString(),
          },
        })
      );

      // ✅ timeline event on FULL order
      await addTimelineEvent({
        orderId: fullOrderId,
        event: "SLOT_BOOKED_FULL",
        by: String(managerId || "MANAGER"),
        role: "BOOKING",
        data: {
          mergeKey,
          time,
          pos: chosenPos,
          mergedOrderIds,
          originalOrderId: b.orderId,
        },
        eventId: `MERGE_CONFIRM#${mergeKey}#${date}#${time}`,
      });
    }
  }

  return {
    ok: true,
    mergeKey,
    fullOrderId,
    totalAmount: total,
    status: "FULL",
    pos: chosenPos,
    mergedOrderIds,
  };
}
